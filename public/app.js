import { renderMarkdown } from '/markdown.js';

const $ = (sel) => document.querySelector(sel);
const messagesEl = $('#messages');
const emptyState = $('#empty-state');
const input = $('#input');
const form = $('#composer');
const sendBtn = $('#send');
const stopBtn = $('#stop');
const statusDot = $('#status-dot');
const statusText = $('#subtitle');

// crypto.randomUUID / navigator.clipboard only exist in secure contexts
// (https or localhost). This app is often served over plain http://LAN-IP,
// so both need fallbacks.
function uuid() {
  if (window.crypto?.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } finally { ta.remove(); }
  return Promise.resolve();
}

let sessionId = localStorage.getItem('talkinter.session') || uuid();
localStorage.setItem('talkinter.session', sessionId);
let authToken = localStorage.getItem('talkinter.token') || '';
let inflight = null; // AbortController for the active request
let subtitleDefault = '';

// ---- bootstrap branding / auth / connectivity ----
async function init() {
  try {
    const cfg = await fetch('/api/config').then((r) => r.json());
    document.title = cfg.title || 'Talkinter';
    $('#title').textContent = cfg.title || 'Talkinter';
    subtitleDefault = `${cfg.subtitle || ''} · ${cfg.adapter}`;
    statusText.textContent = subtitleDefault;
    setStatus('ok');
    if (cfg.authRequired && !authToken) promptForToken();
  } catch {
    setStatus('error');
    statusText.textContent = '無法連線到伺服器';
  }
}

function setStatus(state) {
  // state: 'ok' (green) | 'busy' (amber pulse) | 'error' (red)
  statusDot.className = `dot ${state}`;
}

function promptForToken() {
  const t = window.prompt('需要存取密碼 (AUTH_TOKEN):', '');
  if (t) {
    authToken = t.trim();
    localStorage.setItem('talkinter.token', authToken);
  }
}

// ---- message rendering ----
function addMessage(role, text) {
  emptyState?.remove();
  const msg = document.createElement('div');
  msg.className = `msg ${role}`;
  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = role === 'user' ? '🧑' : '🤖';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (role === 'user') {
    bubble.textContent = text;
  } else {
    bubble.innerHTML = text ? renderMarkdown(text) : thinkingIndicator();
  }
  msg.append(avatar, bubble);
  messagesEl.appendChild(msg);
  scrollToBottom();
  return bubble;
}

function thinkingIndicator() {
  return (
    '<span class="thinking"><span class="typing"><span></span><span></span><span></span></span>' +
    '<span class="thinking-label">思考中…</span></span>'
  );
}

function showError(bubble, accText, errText) {
  const base = accText.trim() ? renderMarkdown(accText) : '';
  bubble.innerHTML =
    base + `<div class="error-box">⚠️ ${escapeHtml(errText)}</div>`;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function wireCopyButtons(scope) {
  scope.querySelectorAll('.copy-btn').forEach((btn) => {
    if (btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', () => {
      const code = btn.parentElement.querySelector('code')?.innerText || '';
      copyText(code).then(() => {
        btn.textContent = 'copied';
        setTimeout(() => (btn.textContent = 'copy'), 1200);
      });
    });
  });
}

// ---- sending ----
async function send(text) {
  addMessage('user', text);
  const bubble = addMessage('bot', '');

  setSending(true);
  setStatus('busy');
  statusText.textContent = '等待回應…';
  inflight = new AbortController();
  let acc = '';
  let failed = false;

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
      body: JSON.stringify({ sessionId, message: text }),
      signal: inflight.signal,
    });

    if (res.status === 401) {
      failed = true;
      showError(bubble, '', '密碼錯誤或未授權。請重新整理頁面並輸入正確的存取密碼。');
      localStorage.removeItem('talkinter.token');
      authToken = '';
      return;
    }
    if (!res.ok || !res.body) {
      throw new Error(`伺服器回應 HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let gotFirst = false;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let evt;
        try { evt = JSON.parse(line); } catch { continue; }
        if (evt.type === 'chunk') {
          if (!gotFirst) {
            gotFirst = true;
            statusText.textContent = '回應中…';
          }
          acc += evt.text;
          bubble.innerHTML = renderMarkdown(acc);
          wireCopyButtons(bubble);
          scrollToBottom();
        } else if (evt.type === 'error') {
          failed = true;
          showError(bubble, acc, evt.error);
        }
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      acc += acc ? '\n\n_(已停止)_' : '_(已停止)_';
      bubble.innerHTML = renderMarkdown(acc);
    } else {
      failed = true;
      showError(bubble, acc, `連線失敗：${err.message}`);
    }
  } finally {
    if (!failed && !acc.trim() && !bubble.querySelector('.error-box')) {
      showError(bubble, '', 'Agent 沒有任何回應。請檢查伺服器 log（AGENT_CMD 路徑是否正確？）');
      failed = true;
    }
    setSending(false);
    setStatus(failed ? 'error' : 'ok');
    statusText.textContent = subtitleDefault || '';
    inflight = null;
    scrollToBottom();
    input.focus();
  }
}

function setSending(on) {
  sendBtn.disabled = on;
  stopBtn.hidden = !on;
}

// ---- events ----
form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (inflight) return;
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  autoresize();
  send(text);
});

stopBtn.addEventListener('click', () => inflight?.abort());

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    form.requestSubmit();
  }
});

input.addEventListener('input', autoresize);
function autoresize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 180) + 'px';
}

$('#new-chat').addEventListener('click', async () => {
  if (!window.confirm('開始新對話？目前的對話紀錄會被清除。')) return;
  if (inflight) inflight.abort();
  try {
    await fetch('/api/reset', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
      body: JSON.stringify({ sessionId }),
    });
  } catch { /* ignore */ }
  sessionId = uuid();
  localStorage.setItem('talkinter.session', sessionId);
  messagesEl.innerHTML = '';
  const empty = document.createElement('div');
  empty.className = 'empty';
  empty.id = 'empty-state';
  empty.innerHTML = '<div class="empty-emoji">💬</div><p>開始和你的 agent 聊天吧</p>';
  messagesEl.appendChild(empty);
  input.focus();
});

// Surface any unexpected JS error instead of dying silently.
window.addEventListener('error', (e) => {
  setStatus('error');
  if (statusText) statusText.textContent = `前端錯誤：${e.message}`;
});

init();
input.focus();
