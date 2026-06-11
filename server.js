import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { getAdapter } from './lib/adapters.js';
import { getHistory, append, reset } from './lib/sessions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

const adapter = getAdapter();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/api/config' && req.method === 'GET') {
      return sendJson(res, 200, {
        title: config.title,
        subtitle: config.subtitle,
        adapter: config.adapter,
        authRequired: Boolean(config.authToken),
      });
    }

    if (url.pathname === '/api/chat' && req.method === 'POST') {
      return handleChat(req, res);
    }

    // Progress of the current (or recently finished) turn, so a client whose
    // streaming connection died (phone switched apps) can pick the reply back up.
    if (url.pathname === '/api/turn' && req.method === 'GET') {
      if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
      const sid = url.searchParams.get('sessionId') || '';
      const turn = activeTurns.get(sid);
      if (!turn) return sendJson(res, 200, { state: 'idle' });
      return sendJson(res, 200, {
        state: turn.done ? (turn.error ? 'error' : 'done') : 'running',
        text: turn.text,
        error: turn.error,
      });
    }

    // Explicit stop (the client aborting its connection no longer stops generation).
    if (url.pathname === '/api/stop' && req.method === 'POST') {
      if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
      const body = await readBody(req);
      const turn = activeTurns.get(String(body.sessionId || ''));
      if (turn && !turn.done) turn.ac.abort();
      return sendJson(res, 200, { ok: true });
    }

    if (url.pathname === '/api/reset' && req.method === 'POST') {
      if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
      const body = await readBody(req);
      const sid = String(body.sessionId || '');
      const turn = activeTurns.get(sid);
      if (turn && !turn.done) turn.ac.abort();
      activeTurns.delete(sid);
      reset(sid);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'GET') {
      return serveStatic(url.pathname, res);
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    console.error('Request error:', err);
    if (!res.headersSent) sendJson(res, 500, { error: String(err.message || err) });
    else res.end();
  }
});

// The active (or recently finished) turn per session. Generation continues
// even if the browser drops the streaming connection (mobile app switch);
// the client recovers the accumulated text via GET /api/turn.
const activeTurns = new Map(); // sessionId -> { text, done, error, ac, timer }
const TURN_RETENTION_MS = 10 * 60 * 1000;

async function handleChat(req, res) {
  if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' });

  const body = await readBody(req);
  const message = String(body.message || '').slice(0, 100_000);
  const sessionId = String(body.sessionId || crypto.randomUUID());
  if (!message.trim()) return sendJson(res, 400, { error: 'empty message' });

  const existing = activeTurns.get(sessionId);
  if (existing && !existing.done) {
    return sendJson(res, 409, { error: 'a reply is already in progress' });
  }
  if (existing?.timer) clearTimeout(existing.timer);

  const history = getHistory(sessionId);
  const ac = new AbortController();
  const turn = { text: '', done: false, error: null, ac, timer: null };
  activeTurns.set(sessionId, turn);

  // Stream newline-delimited JSON events back to the browser.
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });

  let clientGone = false;
  req.on('close', () => { clientGone = true; });
  const write = (obj) => {
    if (clientGone) return;
    try { res.write(JSON.stringify(obj) + '\n'); } catch { clientGone = true; }
  };

  try {
    for await (const chunk of adapter({ sessionId, history, message, signal: ac.signal })) {
      turn.text += chunk;
      write({ type: 'chunk', text: chunk });
      if (ac.signal.aborted) break;
    }
    append(sessionId, 'user', message);
    if (turn.text) append(sessionId, 'assistant', turn.text);
    write({ type: 'done', sessionId });
  } catch (err) {
    console.error('Adapter error:', err);
    turn.error = String(err.message || err);
    write({ type: 'error', error: turn.error });
  } finally {
    turn.done = true;
    if (!clientGone) {
      try { res.end(); } catch { /* connection already gone */ }
    }
    turn.timer = setTimeout(() => {
      if (activeTurns.get(sessionId) === turn) activeTurns.delete(sessionId);
    }, TURN_RETENTION_MS);
  }
}

function serveStatic(pathname, res) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  // Prevent path traversal.
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    return sendJson(res, 403, { error: 'forbidden' });
  }
  fs.readFile(filePath, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'not found' });
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function authorized(req) {
  if (!config.authToken) return true;
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  // Constant-time compare.
  const a = Buffer.from(token);
  const b = Buffer.from(config.authToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 200_000) {
        reject(new Error('payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

server.listen(config.port, config.host, () => {
  console.log(`\n  Talkinter is running`);
  console.log(`  → http://${config.host}:${config.port}`);
  console.log(`  adapter: ${config.adapter}${config.authToken ? '  (auth enabled)' : ''}\n`);
});
