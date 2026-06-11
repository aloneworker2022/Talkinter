import { renderMarkdown } from '/markdown.js';

const $ = (sel) => document.querySelector(sel);
const stageUser = $('#stage-user');
const stageReply = $('#stage-reply');
const input = $('#input');
const form = $('#composer');
const sendBtn = $('#send');
const stopBtn = $('#stop');
const statusDot = $('#status-dot');
const statusText = $('#subtitle');

// crypto.randomUUID / navigator.clipboard only exist in secure contexts
// (https or localhost); this app is often served over plain http://LAN-IP.
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
let inflight = null;
let subtitleDefault = '';

// ---- this conversation's transcript (survives page refresh) ----
const TRANSCRIPT_KEY = 'talkinter.transcript';
let transcript = [];
try { transcript = JSON.parse(localStorage.getItem(TRANSCRIPT_KEY) || '[]'); } catch { transcript = []; }

function saveTranscript() {
  if (transcript.length > 200) transcript = transcript.slice(-200);
  localStorage.setItem(TRANSCRIPT_KEY, JSON.stringify(transcript));
}

// ---- settings (font size / font family / theme) ----
const SETTINGS_KEY = 'talkinter.settings';
const defaults = { fontSize: 15.5, font: 'sans', theme: 'dark' };
let settings = { ...defaults };
try { settings = { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; } catch { /* keep defaults */ }

function applySettings() {
  document.documentElement.style.setProperty('--base-size', settings.fontSize + 'px');
  document.documentElement.dataset.font = settings.font;
  document.documentElement.dataset.theme = settings.theme;
  document.querySelectorAll('.swatch').forEach((s) => {
    s.classList.toggle('active', s.dataset.theme === settings.theme);
  });
  const slider = $('#set-fontsize');
  const val = $('#set-fontsize-val');
  if (slider) slider.value = settings.fontSize;
  if (val) val.textContent = `${settings.fontSize}px`;
  const fontSel = $('#set-font');
  if (fontSel) fontSel.value = settings.font;
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

// ---- bootstrap ----
async function init() {
  applySettings();
  showLastExchange();
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
  statusDot.className = `dot ${state}`;
}

function promptForToken() {
  const t = window.prompt('需要存取密碼 (AUTH_TOKEN):', '');
  if (t) {
    authToken = t.trim();
    localStorage.setItem('talkinter.token', authToken);
  }
}

// ---- stage rendering (novel style: only the current exchange) ----
function showEmpty() {
  stageUser.hidden = true;
  stageUser.textContent = '';
  stageReply.innerHTML =
    '<div class="empty"><div class="empty-emoji">💬</div><p>開始和你的 agent 聊天吧</p></div>';
}

function showLastExchange() {
  // After a refresh, restore the most recent user/assistant pair.
  const lastUser = [...transcript].reverse().find((m) => m.role === 'user');
  const lastBot = [...transcript].reverse().find((m) => m.role === 'assistant');
  if (!lastUser && !lastBot) {
    showEmpty();
    return;
  }
  if (lastUser) {
    stageUser.hidden = false;
    stageUser.textContent = lastUser.content;
  }
  stageReply.innerHTML = lastBot ? renderMarkdown(lastBot.content) : '';
  wireCopyButtons(stageReply);
}

function thinkingIndicator() {
  return (
    '<span class="thinking"><span class="typing"><span></span><span></span><span></span></span>' +
    '<span class="thinking-label">思考中…</span></span>'
  );
}

function showError(accText, errText) {
  const base = accText.trim() ? renderMarkdown(accText) : '';
  stageReply.innerHTML = base + `<div class="error-box">⚠️ ${escapeHtml(errText)}</div>`;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
  stageUser.hidden = false;
  stageUser.textContent = text;
  stageReply.innerHTML = thinkingIndicator();
  stageReply.classList.add('caret');

  transcript.push({ role: 'user', content: text });
  saveTranscript();

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
      showError('', '密碼錯誤或未授權。請重新整理頁面並輸入正確的存取密碼。');
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
          stageReply.innerHTML = renderMarkdown(acc);
          wireCopyButtons(stageReply);
          stageReply.scrollTop = stageReply.scrollHeight;
        } else if (evt.type === 'error') {
          failed = true;
          showError(acc, evt.error);
        }
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      acc += acc ? '\n\n_(已停止)_' : '_(已停止)_';
      stageReply.innerHTML = renderMarkdown(acc);
    } else {
      failed = true;
      showError(acc, `連線失敗：${err.message}`);
    }
  } finally {
    stageReply.classList.remove('caret');
    if (!failed && !acc.trim() && !stageReply.querySelector('.error-box')) {
      showError('', 'Agent 沒有任何回應。請檢查伺服器 log。');
      failed = true;
    }
    if (acc.trim()) {
      transcript.push({ role: 'assistant', content: acc });
      saveTranscript();
    }
    setSending(false);
    setStatus(failed ? 'error' : 'ok');
    statusText.textContent = subtitleDefault || '';
    inflight = null;
    input.focus();
  }
}

function setSending(on) {
  sendBtn.disabled = on;
  stopBtn.hidden = !on;
}

// ---- composer events ----
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

// ---- new chat ----
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
  transcript = [];
  saveTranscript();
  showEmpty();
  input.focus();
});

// ---- modals ----
function openModal(id) { $(`#${id}`).hidden = false; }
function closeModal(id) { $(`#${id}`).hidden = true; }

$('#open-settings').addEventListener('click', () => openModal('settings-modal'));

document.querySelectorAll('.modal-close').forEach((btn) => {
  btn.addEventListener('click', () => closeModal(btn.dataset.close));
});
document.querySelectorAll('.modal').forEach((m) => {
  m.addEventListener('click', (e) => {
    if (e.target === m) m.hidden = true; // click on the backdrop closes
  });
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.querySelectorAll('.modal').forEach((m) => (m.hidden = true));
});

// settings controls
$('#set-fontsize').addEventListener('input', (e) => {
  settings.fontSize = Number(e.target.value);
  saveSettings();
  applySettings();
});
$('#set-font').addEventListener('change', (e) => {
  settings.font = e.target.value;
  saveSettings();
  applySettings();
});
document.querySelectorAll('.swatch').forEach((s) => {
  s.addEventListener('click', () => {
    settings.theme = s.dataset.theme;
    saveSettings();
    applySettings();
  });
});

// history (this conversation only)
$('#open-history').addEventListener('click', () => {
  const list = $('#history-list');
  if (!transcript.length) {
    list.innerHTML = '<div class="history-empty">這次對話還沒有內容</div>';
  } else {
    list.innerHTML = transcript
      .map((m) => {
        const role = m.role === 'user' ? '你' : 'Agent';
        const body =
          m.role === 'user' ? escapeHtml(m.content) : `<div class="md">${renderMarkdown(m.content)}</div>`;
        return `<div class="history-item ${m.role === 'user' ? 'user' : 'bot'}">` +
          `<div class="history-role">${role}</div>` +
          `<div class="history-body">${body}</div></div>`;
      })
      .join('');
    wireCopyButtons(list);
  }
  closeModal('settings-modal');
  openModal('history-modal');
  list.scrollTop = list.scrollHeight;
});

// Surface any unexpected JS error instead of dying silently.
window.addEventListener('error', (e) => {
  setStatus('error');
  if (statusText) statusText.textContent = `前端錯誤：${e.message}`;
});

init();
input.focus();
