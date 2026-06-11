import { renderMarkdown } from '/markdown.js';

const $ = (sel) => document.querySelector(sel);
const messagesEl = $('#messages');
const emptyState = $('#empty-state');
const input = $('#input');
const form = $('#composer');
const sendBtn = $('#send');
const stopBtn = $('#stop');

let sessionId = localStorage.getItem('talkinter.session') || crypto.randomUUID();
localStorage.setItem('talkinter.session', sessionId);
let authToken = localStorage.getItem('talkinter.token') || '';
let inflight = null; // AbortController for the active request

// ---- bootstrap branding / auth ----
async function init() {
  try {
    const cfg = await fetch('/api/config').then((r) => r.json());
    document.title = cfg.title || 'Talkinter';
    $('#title').textContent = cfg.title || 'Talkinter';
    $('#subtitle').textContent = cfg.subtitle || '';
    $('#adapter-tag').textContent = cfg.adapter || '';
    if (cfg.authRequired && !authToken) promptForToken();
  } catch {
    /* offline / config error — UI still works */
  }
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
    bubble.innerHTML = text ? renderMarkdown(text) : typingIndicator();
  }
  msg.append(avatar, bubble);
  messagesEl.appendChild(msg);
  scrollToBottom();
  return bubble;
}

function typingIndicator() {
  return '<span class="typing"><span></span><span></span><span></span></span>';
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
      navigator.clipboard.writeText(code).then(() => {
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
  bubble.classList.add('caret');

  setSending(true);
  inflight = new AbortController();
  let acc = '';

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
      bubble.classList.remove('caret');
      bubble.innerHTML = '<em>未授權。請重新整理並輸入正確的存取密碼。</em>';
      localStorage.removeItem('talkinter.token');
      authToken = '';
      return;
    }
    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

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
          acc += evt.text;
          bubble.innerHTML = renderMarkdown(acc);
          wireCopyButtons(bubble);
          scrollToBottom();
        } else if (evt.type === 'error') {
          acc += `\n\n> ⚠️ ${evt.error}`;
          bubble.innerHTML = renderMarkdown(acc);
        }
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      acc += acc ? '\n\n> _(已停止)_' : '_(已停止)_';
    } else {
      acc += `\n\n> ⚠️ ${err.message}`;
    }
    bubble.innerHTML = renderMarkdown(acc);
  } finally {
    bubble.classList.remove('caret');
    if (!acc.trim()) bubble.innerHTML = '<em>（沒有回應）</em>';
    setSending(false);
    inflight = null;
    scrollToBottom();
  }
}

function setSending(on) {
  sendBtn.disabled = on;
  stopBtn.hidden = !on;
  input.disabled = false;
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
  sessionId = crypto.randomUUID();
  localStorage.setItem('talkinter.session', sessionId);
  messagesEl.innerHTML = '';
  const empty = document.createElement('div');
  empty.className = 'empty';
  empty.innerHTML = '<div class="empty-emoji">💬</div><p>開始和你的 agent 聊天吧</p>';
  messagesEl.appendChild(empty);
  input.focus();
});

init();
input.focus();
