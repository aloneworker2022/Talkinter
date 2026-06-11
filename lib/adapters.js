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
  const messages = [];
  if (config.httpSystemPrompt) {
    messages.push({ role: 'system', content: config.httpSystemPrompt });
  }
  for (const m of history) messages.push({ role: m.role, content: m.content });
  messages.push({ role: 'user', content: message });

  const res = await fetch(config.httpUrl, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      ...(config.httpKey ? { Authorization: `Bearer ${config.httpKey}` } : {}),
    },
    body: JSON.stringify({ model: config.httpModel, messages, stream: true }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Upstream ${res.status}: ${body.slice(0, 500)}`);
  }

  // Parse Server-Sent Events: lines beginning with "data: ".
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        const json = JSON.parse(payload);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {
        // ignore keep-alive / non-JSON lines
      }
    }
  }
}

// ---------------------------------------------------------------------------
// command: wrap an arbitrary CLI agent (this is the SSH-terminal replacement).
// ---------------------------------------------------------------------------
const persistentProcs = new Map(); // sessionId -> child process

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

function buildArgs(message) {
  // Splits AGENT_CMD on whitespace (respecting simple quotes) and substitutes
  // the {message} placeholder. Returns { cmd, args, pipeStdin }.
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
  const { cmd, args, pipeStdin } = buildArgs(message);
  const child = spawn(cmd, args, {
    cwd: config.commandCwd,
    signal,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (pipeStdin) {
    child.stdin.write(message.endsWith('\n') ? message : message + '\n');
    child.stdin.end();
  }

  const queue = new ChunkQueue();
  child.stdout.on('data', (d) => queue.push(d.toString()));
  child.stderr.on('data', (d) => queue.push(d.toString()));
  child.on('error', (err) => queue.fail(err));
  child.on('close', () => queue.close());

  yield* queue;
}

async function* persistentCommandStream({ sessionId, message, signal }) {
  let proc = persistentProcs.get(sessionId);
  if (!proc || proc.child.killed || proc.child.exitCode !== null) {
    const { cmd, args } = buildArgs(''); // placeholder ignored in persistent mode
    const child = spawn(cmd, args, {
      cwd: config.commandCwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    proc = { child };
    persistentProcs.set(sessionId, proc);
    // Drain any startup banner before the first message.
    await sleep(config.commandIdleMs);
    drain(child);
  }

  const child = proc.child;
  const queue = new ChunkQueue();
  let idleTimer = null;

  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => queue.close(), config.commandIdleMs);
  };

  const onData = (d) => {
    queue.push(d.toString());
    resetIdle();
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  if (signal) {
    signal.addEventListener('abort', () => queue.close(), { once: true });
  }

  child.stdin.write(message.endsWith('\n') ? message : message + '\n');
  resetIdle();

  try {
    yield* queue;
  } finally {
    child.stdout.off('data', onData);
    child.stderr.off('data', onData);
    if (idleTimer) clearTimeout(idleTimer);
  }
}

function drain(child) {
  child.stdout.read();
  child.stderr.read();
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
