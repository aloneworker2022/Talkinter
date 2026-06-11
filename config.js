// Central configuration, all overridable via environment variables.
// Copy .env.example to .env and `source` it, or export the vars directly.

const env = process.env;

// Values from .env files often carry stray whitespace or Windows \r — trim
// them so e.g. "http " doesn't become an unknown adapter.
const str = (key, def = '') => (env[key] ?? def).replace(/\r/g, '').trim();
const int = (key, def) => parseInt(str(key, String(def)), 10) || def;

export const config = {
  // ---- Server ----
  host: str('HOST', '0.0.0.0'),
  port: int('PORT', 8787),

  // Optional shared password. If set, the UI asks for it once and sends it
  // as a bearer token with every request. Leave empty to disable auth.
  authToken: str('AUTH_TOKEN'),

  // ---- Agent adapter ----
  // One of: 'mock' | 'command' | 'http'
  adapter: str('AGENT_ADAPTER', 'mock').toLowerCase(),

  // -- command adapter --
  // The CLI to wrap. Use {message} as a placeholder for the user's text;
  // if absent, the message is piped to the process's stdin.
  //   e.g.  AGENT_CMD="hermes chat --prompt {message}"
  //   e.g.  AGENT_CMD="hermes"   (message goes to stdin)
  command: str('AGENT_CMD'),
  // 'oneshot'    -> spawn a fresh process per message (clean completion on exit)
  // 'persistent' -> keep one process per session, detect reply end by idle gap
  commandMode: str('AGENT_CMD_MODE', 'oneshot').toLowerCase(),
  // For persistent mode: ms of stdout silence (after real content has started)
  // that marks the reply as complete. Raise it if your agent pauses mid-answer.
  commandIdleMs: int('AGENT_CMD_IDLE_MS', 900),
  // For persistent mode: how long to wait for the FIRST content of a reply
  // before giving up (covers an agent that "thinks" for a while).
  commandWarmupMs: int('AGENT_CMD_WARMUP_MS', 20000),
  // Run the command under a real pseudo-terminal via util-linux `script`.
  // Needed only for CLIs that refuse to run without a TTY. Implies stdin input.
  commandPty: /^(1|true|yes)$/i.test(str('AGENT_CMD_PTY')),
  // Working directory for the spawned command.
  commandCwd: str('AGENT_CMD_CWD', process.cwd()),

  // -- http adapter (OpenAI-compatible /v1/chat/completions) --
  httpUrl: str('AGENT_HTTP_URL'),
  httpKey: str('AGENT_HTTP_KEY'),
  httpModel: str('AGENT_HTTP_MODEL', 'gpt-3.5-turbo'),
  httpSystemPrompt: str('AGENT_HTTP_SYSTEM'),

  // ---- Branding (shown in the UI) ----
  title: str('APP_TITLE', 'Talkinter'),
  subtitle: str('APP_SUBTITLE', 'Hermes agent'),
};
