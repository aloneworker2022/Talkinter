// In-memory conversation store. Sessions are keyed by an opaque id chosen by
// the client and kept in memory only (cleared on restart). Good enough for a
// single-user / small-team personal agent UI; swap for a DB if you need
// persistence.

const sessions = new Map(); // id -> { messages: [...], updated: ts }
const MAX_MESSAGES = 200;

export function getHistory(id) {
  return sessions.get(id)?.messages ?? [];
}

export function append(id, role, content) {
  let s = sessions.get(id);
  if (!s) {
    s = { messages: [], updated: Date.now() };
    sessions.set(id, s);
  }
  s.messages.push({ role, content });
  if (s.messages.length > MAX_MESSAGES) {
    s.messages.splice(0, s.messages.length - MAX_MESSAGES);
  }
  s.updated = Date.now();
}

export function reset(id) {
  sessions.delete(id);
}
