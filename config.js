// Central configuration, all overridable via environment variables.
// Copy .env.example to .env and `source` it, or export the vars directly.

const env = process.env;

export const config = {
  // ---- Server ----
  host: env.HOST || '0.0.0.0',
  port: parseInt(env.PORT || '8787', 10),

  // Optional shared password. If set, the UI asks for it once and sends it
  // as a bearer token with every request. Leave empty to disable auth.
  authToken: env.AUTH_TOKEN || '',

  // ---- Agent adapter ----
  // One of: 'mock' | 'command' | 'http'
  adapter: env.AGENT_ADAPTER || 'mock',

  // -- command adapter --
  // The CLI to wrap. Use {message} as a placeholder for the user's text;
  // if absent, the message is piped to the process's stdin.
  //   e.g.  AGENT_CMD="hermes chat --prompt {message}"
  //   e.g.  AGENT_CMD="hermes"   (message goes to stdin)
  command: env.AGENT_CMD || '',
  // 'oneshot'    -> spawn a fresh process per message (clean completion on exit)
  // 'persistent' -> keep one process per session, detect reply end by idle gap
  commandMode: env.AGENT_CMD_MODE || 'oneshot',
  // For persistent mode: ms of stdout silence (after real content has started)
  // that marks the reply as complete. Raise it if your agent pauses mid-answer.
  commandIdleMs: parseInt(env.AGENT_CMD_IDLE_MS || '900', 10),
  // For persistent mode: how long to wait for the FIRST content of a reply
  // before giving up (covers an agent that "thinks" for a while).
  commandWarmupMs: parseInt(env.AGENT_CMD_WARMUP_MS || '20000', 10),
  // Run the command under a real pseudo-terminal via util-linux `script`.
  // Needed only for CLIs that refuse to run without a TTY. Implies stdin input.
  commandPty: /^(1|true|yes)$/i.test(env.AGENT_CMD_PTY || ''),
  // Working directory for the spawned command.
  commandCwd: env.AGENT_CMD_CWD || process.cwd(),

  // -- http adapter (OpenAI-compatible /v1/chat/completions) --
  httpUrl: env.AGENT_HTTP_URL || '',
  httpKey: env.AGENT_HTTP_KEY || '',
  httpModel: env.AGENT_HTTP_MODEL || 'gpt-3.5-turbo',
  httpSystemPrompt: env.AGENT_HTTP_SYSTEM || '',

  // ---- Branding (shown in the UI) ----
  title: env.APP_TITLE || 'Talkinter',
  subtitle: env.APP_SUBTITLE || 'Hermes agent',
};
