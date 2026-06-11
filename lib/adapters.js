// Adapters translate a chat turn into a stream of text chunks coming back
// from the agent. Each adapter exposes:
//
//   async *stream({ sessionId, history, message, signal }) -> yields string chunks
//
// `history` is an array of { role: 'user'|'assistant', content: string }
// (not including the current `message`).

import { spawn } from 'node:child_process';
import { config } from '../config.js';

// ---------------------------------------------------------------------------
// mock: a self-contained echo agent so the app runs with zero setup.
// ---------------------------------------------------------------------------
async function* mockStream({ message }) {
  const reply =
    `You said: **${message.trim() || '(nothing)'}**\n\n` +
    'This is the built-in `mock` agent. Set `AGENT_ADAPTER=command` or ' +
    '`AGENT_ADAPTER=http` to connect Talkinter to your real Hermes agent.\n\n' +
    '```js\n// streaming works, markdown works, code blocks work\nconsole.log("hello");\n```';
  for (const token of reply.match(/\s+|\S+/g) || []) {
    yield token;
    await sleep(18);
  }
}

// ---------------------------------------------------------------------------
// http: proxy to an OpenAI-compatible streaming chat completions endpoint.
// ---------------------------------------------------------------------------
async function* httpStream({ history, message, signal }) {
  if (!config.httpUrl) {
    throw new Error('AGENT_HTTP_URL is not set');
  }
  // HTTP headers must be Latin-1; a non-ASCII key usually means a placeholder
  // like 你的API_SERVER_KEY was pasted verbatim.
  if (/[^\x20-\x7E]/.test(config.httpKey)) {
    throw new Error(
      'AGENT_HTTP_KEY 含有中文或特殊字元 — 看起來是把範例的佔位文字直接抄進來了。' +
        '請填入你在 hermes 設定的真正 API_SERVER_KEY（grep API_SERVER_KEY ~/.hermes/.env 可查）。'
    );
  }
  const messages = [];
  if (config.httpSystemPrompt) {
    messages.push({ role: 'system', content: config.httpSystemPrompt });
  }
  for (const m of history) messages.push({ role: m.role, content: m.content });
  messages.push({ role: 'user', content: message });

  let res;
  try {
    res = await fetch(config.httpUrl, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        ...(config.httpKey ? { Authorization: `Bearer ${config.httpKey}` } : {}),
      },
      body: JSON.stringify({ model: config.httpModel, messages, stream: true }),
    });
  } catch (err) {
    const code = err.cause?.code || err.code || '';
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ECONNRESET') {
      throw new Error(
        `連不上 agent API（${config.httpUrl}）— 對方沒有在監聽。` +
          `請確認 hermes gateway 正在執行，且 ~/.hermes/.env 裡有 API_SERVER_ENABLED=true。` +
          `可用 curl http://localhost:8642/health 驗證。`
      );
    }
    throw err;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `agent API 拒絕存取（HTTP ${res.status}）— AGENT_HTTP_KEY 是否與 hermes 的 API_SERVER_KEY 一致？`
      );
    }
    throw new Error(`Upstream ${res.status}: ${body.slice(0, 500)}`);
  }

  // If the server ignored stream:true and returned a single JSON document,
  // yield the whole reply at once instead of finding no SSE lines.
  const ctype = res.headers.get('content-type') || '';
  console.log(`[http] upstream ${res.status} content-type=${ctype}`);
  if (!ctype.includes('text/event-stream')) {
    const raw = await res.text().catch(() => '');
    let json = null;
    try { json = JSON.parse(raw); } catch { /* not JSON */ }
    const text =
      json?.choices?.[0]?.message?.content ??
      json?.choices?.[0]?.text ??
      json?.message?.content ??
      json?.content ??
      json?.response ??
      '';
    if (text) {
      yield text;
      return;
    }
    throw new Error(
      `上游回應了，但找不到文字內容（content-type: ${ctype || '?'}）。` +
        `原始回應開頭：${raw.slice(0, 400) || '(空)'}`
    );
  }

  // Parse Server-Sent Events: lines beginning with "data: ".
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let yieldedAny = false;
  let rawSample = '';
  const noContentError = () =>
    new Error(
      `串流結束了，但沒有解析到任何文字 — gateway 的串流格式可能不相容。` +
        `原始串流開頭：${rawSample.slice(0, 400) || '(空)'}`
    );
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    if (rawSample.length < 800) rawSample += buffer.slice(0, 800 - rawSample.length);
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') {
        if (!yieldedAny) throw noContentError();
        return;
      }
      try {
        const json = JSON.parse(payload);
        const delta =
          json.choices?.[0]?.delta?.content ??
          json.choices?.[0]?.message?.content ??
          json.delta?.text ??
          json.content;
        if (typeof delta === 'string' && delta) {
          yieldedAny = true;
          yield delta;
        }
      } catch {
        // ignore keep-alive / non-JSON lines
      }
    }
  }
  if (!yieldedAny) throw noContentError();
}

// ---------------------------------------------------------------------------
// command: wrap an arbitrary CLI agent (this is the SSH-terminal replacement).
// ---------------------------------------------------------------------------
const persistentProcs = new Map(); // sessionId -> { child }

async function* commandStream({ sessionId, message, signal }) {
  if (!config.command) {
    throw new Error('AGENT_CMD is not set');
  }
  if (config.commandMode === 'persistent') {
    yield* persistentCommandStream({ sessionId, message, signal });
  } else {
    yield* oneshotCommandStream({ message, signal });
  }
}

// Resolve AGENT_CMD into a spawnable { cmd, args, pipeStdin }, optionally
// wrapping it in a pseudo-terminal via util-linux `script` for TTY-only CLIs.
function buildSpawn(message) {
  if (config.commandPty) {
    const usedPlaceholder = config.command.includes('{message}');
    const cmdString = config.command.replaceAll('{message}', shellQuote(message));
    // `script -qec "<cmd>" /dev/null` runs <cmd> attached to a real PTY.
    return { cmd: 'script', args: ['-qec', cmdString, '/dev/null'], pipeStdin: !usedPlaceholder };
  }
  const tokens = tokenize(config.command);
  const cmd = tokens.shift();
  let pipeStdin = true;
  const args = tokens.map((t) => {
    if (t.includes('{message}')) {
      pipeStdin = false;
      return t.replaceAll('{message}', message);
    }
    return t;
  });
  return { cmd, args, pipeStdin };
}

async function* oneshotCommandStream({ message, signal }) {
  const { cmd, args, pipeStdin } = buildSpawn(message);
  const child = spawn(cmd, args, {
    cwd: config.commandCwd,
    signal,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (pipeStdin) {
    child.stdin.write(message.endsWith('\n') ? message : message + '\n');
    child.stdin.end();
  }

  // In a fresh one-shot process there's normally no terminal echo, so only
  // strip ANSI / prompts unless we deliberately attached a PTY.
  const cleaner = new OutputCleaner({ message, dropEcho: config.commandPty });
  const queue = new ChunkQueue();
  const onData = (d) => {
    const out = cleaner.push(d.toString());
    if (out) queue.push(out);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('error', (err) => queue.fail(err));
  child.on('close', () => {
    const tail = cleaner.flush();
    if (tail) queue.push(tail);
    queue.close();
  });

  yield* queue;
}

async function* persistentCommandStream({ sessionId, message, signal }) {
  let proc = persistentProcs.get(sessionId);
  if (!proc || proc.child.killed || proc.child.exitCode !== null) {
    const { cmd, args } = buildSpawn(''); // placeholder unused in persistent mode
    const child = spawn(cmd, args, {
      cwd: config.commandCwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    proc = { child, spawnError: null, startupOutput: '' };
    child.on('error', (err) => { proc.spawnError = err; });
    const onStartupErr = (d) => { proc.startupOutput += d.toString(); };
    child.stderr.on('data', onStartupErr);
    persistentProcs.set(sessionId, proc);
    // Let any startup banner print and drain it before the first message.
    await sleep(Math.min(config.commandIdleMs, 800));
    child.stderr.off('data', onStartupErr);
    if (proc.spawnError || child.exitCode !== null) {
      persistentProcs.delete(sessionId);
      const detail = proc.spawnError
        ? proc.spawnError.code === 'ENOENT'
          ? `找不到指令 "${cmd}" — 請確認 AGENT_CMD 的路徑是否正確`
          : proc.spawnError.message
        : `行程啟動後立刻結束 (exit ${child.exitCode})${
            proc.startupOutput ? `: ${stripAnsi(proc.startupOutput).trim().slice(0, 300)}` : ''
          }`;
      throw new Error(detail);
    }
    child.stdout.read();
    child.stderr.read();
  }

  const child = proc.child;
  const cleaner = new OutputCleaner({ message, dropEcho: true });
  const queue = new ChunkQueue();
  let firstContent = false;
  let idleTimer = null;
  let warmupTimer = null;

  const finish = () => {
    const tail = cleaner.flush();
    if (tail) queue.push(tail);
    queue.close();
  };
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(finish, config.commandIdleMs);
  };

  const onData = (d) => {
    const out = cleaner.push(d.toString());
    if (out) queue.push(out);
    if (!firstContent && out.trim()) {
      firstContent = true;
      if (warmupTimer) clearTimeout(warmupTimer);
    }
    if (firstContent) armIdle(); // only count idle time once a reply is underway
  };

  const onExit = () => {
    queue.push('\n\n> ⚠️ Agent 行程已結束，下一則訊息會自動重新啟動它。\n');
    finish();
  };

  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('exit', onExit);
  // If the agent never produces content, don't hang forever.
  warmupTimer = setTimeout(finish, config.commandWarmupMs);
  if (signal) signal.addEventListener('abort', finish, { once: true });

  child.stdin.write(message.endsWith('\n') ? message : message + '\n');

  try {
    yield* queue;
  } finally {
    child.stdout.off('data', onData);
    child.stderr.off('data', onData);
    child.off('exit', onExit);
    if (idleTimer) clearTimeout(idleTimer);
    if (warmupTimer) clearTimeout(warmupTimer);
  }
}

// ---------------------------------------------------------------------------
// Cleaning output from an interactive REPL (e.g. `hermes`) so the browser sees
// readable text: strip ANSI escapes, drop the echoed input line, and drop the
// prompt the REPL prints (">", "hermes>", "❯", ">>>", ...). Works line by line.
// ---------------------------------------------------------------------------

// Standard ANSI / VT control-sequence matcher (colours, cursor moves, OSC...).
// Built from a string so no raw control bytes live in the source.
const ANSI_RE = new RegExp(
  '[\\u001B\\u009B][[\\]()#;?]*(?:(?:[a-zA-Z\\d]*(?:;[a-zA-Z\\d]*)*)?\\u0007|' +
    '(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~])',
  'g'
);
const PROMPT_RE = /^\s*(?:[>❯»]|hermes\s*[>:]?|>>>|\.\.\.)\s*$/i;
// A line that is only a horizontal separator (3+ of the same family of chars).
const SEPARATOR_RE = /^\s*[-_=~─━═╌┄┅┈┉⎯—–·•]{3,}\s*$/;
// A line made entirely of box-drawing characters and whitespace.
const BOX_ONLY_RE = /^[\s─━│┃┄┅┆┇┈┉┊┋╌╍╎╏┌┐└┘├┤┬┴┼╭╮╰╯═║╔╗╚╝╠╣╦╩╬]+$/;

function stripAnsi(s) {
  return s.replace(ANSI_RE, '').replace(/\r/g, '');
}

class OutputCleaner {
  constructor({ message = '', dropEcho = false, stripPrompt = true } = {}) {
    this.buf = '';
    this.message = message.trim();
    this.dropEcho = dropEcho;
    this.stripPrompt = stripPrompt;
    this.droppedEcho = false;
    this.emittedAny = false;
  }
  // Returns cleaned text for any newly-completed lines.
  push(raw) {
    this.buf += raw;
    let out = '';
    let nl;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = stripAnsi(this.buf.slice(0, nl));
      this.buf = this.buf.slice(nl + 1);
      out += this._consider(line, true);
    }
    return out;
  }
  // Returns any held-back trailing text (a final line without a newline).
  flush() {
    if (!this.buf) return '';
    const line = stripAnsi(this.buf);
    this.buf = '';
    return this._consider(line, false);
  }
  _consider(line, hadNewline) {
    // Drop a single leading echo of what the user typed (terminals echo input).
    // Under a real PTY the echo is often glued to the prompt ("> hello"), so we
    // also accept a line that is just a prompt prefix followed by the message.
    if (this.dropEcho && !this.droppedEcho && this.message) {
      const t = line.trim();
      const echoed =
        t === this.message ||
        (t.endsWith(this.message) &&
          /^[>❯»#$:\s]*$/.test(t.slice(0, t.length - this.message.length)));
      if (echoed) {
        this.droppedEcho = true;
        return '';
      }
    }
    // Drop prompt-only lines.
    if (this.stripPrompt && PROMPT_RE.test(line)) return '';
    // Drop decorative terminal lines: separators (────, ====, ----) and
    // box-drawing borders (╭──╮, │  │, ╰──╯) that TUI agents print.
    if (SEPARATOR_RE.test(line) || (line.trim() !== '' && BOX_ONLY_RE.test(line))) return '';
    // Strip box-drawing side borders around real content: "│ text │" -> "text".
    line = line.replace(/^\s*[│┃║]\s?/, '').replace(/\s?[│┃║]\s*$/, '');
    // Swallow leading blank lines before any real content arrives.
    if (!this.emittedAny && line.trim() === '') return '';
    this.emittedAny = true;
    return hadNewline ? line + '\n' : line;
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// A push/pull bridge so event-based stdout can be consumed as an async iterator.
class ChunkQueue {
  constructor() {
    this.chunks = [];
    this.resolvers = [];
    this.done = false;
    this.error = null;
  }
  push(chunk) {
    if (this.resolvers.length) this.resolvers.shift()({ value: chunk, done: false });
    else this.chunks.push(chunk);
  }
  close() {
    this.done = true;
    while (this.resolvers.length) this.resolvers.shift()({ value: undefined, done: true });
  }
  fail(err) {
    this.error = err;
    this.close();
  }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.error) return Promise.reject(this.error);
        if (this.chunks.length) {
          return Promise.resolve({ value: this.chunks.shift(), done: false });
        }
        if (this.done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.resolvers.push(resolve));
      },
    };
  }
}

function tokenize(str) {
  // Minimal shell-ish tokenizer honouring single and double quotes.
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3]);
  }
  return out;
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
export function getAdapter() {
  switch (config.adapter) {
    case 'mock':
      return mockStream;
    case 'http':
      return httpStream;
    case 'command':
      return commandStream;
    default:
      throw new Error(`Unknown AGENT_ADAPTER: ${config.adapter}`);
  }
}
