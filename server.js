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

    if (url.pathname === '/api/reset' && req.method === 'POST') {
      if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
      const body = await readBody(req);
      reset(body.sessionId || '');
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

async function handleChat(req, res) {
  if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' });

  const body = await readBody(req);
  const message = String(body.message || '').slice(0, 100_000);
  const sessionId = String(body.sessionId || crypto.randomUUID());
  if (!message.trim()) return sendJson(res, 400, { error: 'empty message' });

  const history = getHistory(sessionId);

  // Stream newline-delimited JSON events back to the browser.
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });

  const ac = new AbortController();
  req.on('close', () => ac.abort());

  const write = (obj) => res.write(JSON.stringify(obj) + '\n');
  let full = '';

  try {
    for await (const chunk of adapter({ sessionId, history, message, signal: ac.signal })) {
      if (ac.signal.aborted) break;
      full += chunk;
      write({ type: 'chunk', text: chunk });
    }
    if (!ac.signal.aborted) {
      append(sessionId, 'user', message);
      append(sessionId, 'assistant', full);
      write({ type: 'done', sessionId });
    }
  } catch (err) {
    console.error('Adapter error:', err);
    write({ type: 'error', error: String(err.message || err) });
  } finally {
    res.end();
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
