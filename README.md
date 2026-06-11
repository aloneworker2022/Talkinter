# Talkinter

A simple, clean web chat interface for the **Hermes** agent — a friendlier
replacement for typing over SSH or chatting through Telegram.

- **Zero dependencies.** Pure Node.js (built-in modules only). No `npm install`,
  no build step. Just `node server.js`.
- **Plug into any agent.** Three adapters: wrap a CLI (`command`), call an
  OpenAI-compatible HTTP API (`http`), or try it instantly with the built-in
  `mock` agent.
- **Real chat UX.** Streaming token-by-token output, Markdown + code blocks with
  copy buttons, conversation memory, mobile-friendly, dark theme, optional
  password.

![chat](https://img.shields.io/badge/node-%3E=18-43a047) ![deps](https://img.shields.io/badge/dependencies-0-blue)

---

## Quick start

```bash
node server.js
# open http://localhost:8787
```

That runs the built-in `mock` agent so you can see the UI immediately. Now point
it at your real agent.

## Connect to Hermes

> **First, make sure plain `hermes` already works for you in the terminal.**
> On first run Hermes asks you to pick an LLM provider (Nous Portal, OpenRouter,
> OpenAI, ...) and enter that provider's API key. If that setup isn't done,
> Hermes won't answer anything — and neither will Talkinter. This is the
> "registration" step; it belongs to Hermes, not to Talkinter.

### Recommended: Hermes gateway (OpenAI-compatible API) ← use this

`hermes` on its own is a full-screen **TUI**, which can't be driven cleanly
through pipes. Instead use Hermes's built-in API server, which is exactly what
Talkinter's `http` adapter is for:

1. **Enable the API server** — it is OFF by default. Add to `~/.hermes/.env`:
   ```bash
   API_SERVER_ENABLED=true
   API_SERVER_KEY=my-secret
   # optional: API_SERVER_PORT=8642  API_SERVER_HOST=127.0.0.1
   ```
2. Start the gateway (it serves an OpenAI-compatible API on `127.0.0.1:8642`):
   ```bash
   hermes gateway
   # verify:  curl http://localhost:8642/health
   ```
   `ECONNREFUSED` from Talkinter means this step is missing — nothing is
   listening on the port.
3. Point Talkinter at it:
   ```bash
   AGENT_ADAPTER=http \
   AGENT_HTTP_URL=http://localhost:8642/v1/chat/completions \
   AGENT_HTTP_KEY=my-secret \
   node server.js
   ```

The `/v1/chat/completions` path matters — `/v1` alone won't work. Talkinter
streams the reply and keeps the conversation going. (If the gateway runs on
another machine, replace `localhost` with its address.)

### Alternative: one-shot CLI query

Hermes can answer a single prompt without the TUI via `hermes chat -q`. This
uses the **command** adapter and relies on Hermes's own persistent memory to
carry context between messages:

```bash
AGENT_ADAPTER=command AGENT_CMD="hermes chat -q {message}" node server.js
```

### Wrapping a plain line-based REPL (not Hermes' TUI)

For a simple REPL agent that reads a line of stdin and prints a reply (no
full-screen TUI), persistent mode keeps one process alive per browser session:

```bash
AGENT_ADAPTER=command AGENT_CMD="your-agent" AGENT_CMD_MODE=persistent node server.js
```

Talkinter automatically cleans up what an interactive CLI prints so the web UI
stays readable:

- **ANSI colour codes** are stripped.
- The **prompt** it reprints (`>`, `hermes>`, `❯`, ...) is removed.
- The **echo** of your own input line is removed.
- **TUI decorations** are removed: separator lines (`────`, `====`) and
  box-drawing borders (`╭──╮`, `│ text │`, `╰──╯`).

Because a REPL never says "I'm done", a reply is treated as complete after
`AGENT_CMD_IDLE_MS` (default 900ms) of silence — but only *after* the first real
output, so an agent that thinks for a few seconds is never cut off early (it
waits up to `AGENT_CMD_WARMUP_MS`, default 20s, for the first token). If Hermes
pauses mid-answer and gets cut off, raise `AGENT_CMD_IDLE_MS`.

If `hermes` refuses to run because it isn't attached to a terminal, add
`AGENT_CMD_PTY=1` to run it under a real pseudo-terminal (via `script`):

```bash
AGENT_ADAPTER=command AGENT_CMD="hermes" AGENT_CMD_MODE=persistent AGENT_CMD_PTY=1 node server.js
```

### Other CLI shapes

- One-shot command (Hermes keeps its own history): use `{message}` as the
  placeholder, default `oneshot` mode spawns a fresh process per message and
  streams until it exits.
  ```bash
  AGENT_ADAPTER=command AGENT_CMD="hermes chat --prompt {message}" node server.js
  ```
- Omit `{message}` and the text is piped to the command's **stdin** instead.

### Option B — OpenAI-compatible HTTP API

If Hermes (or a model server like Ollama, vLLM, LM Studio, llama.cpp) exposes a
`/v1/chat/completions` endpoint:

```bash
AGENT_ADAPTER=http \
AGENT_HTTP_URL=http://localhost:11434/v1/chat/completions \
AGENT_HTTP_MODEL=hermes3 \
node server.js
```

Talkinter sends the running conversation and streams the response back.

## Configuration

All settings are environment variables (see `.env.example`):

| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `8787` / `0.0.0.0` | where the server listens |
| `AUTH_TOKEN` | _(empty)_ | if set, the UI asks for this password once |
| `AGENT_ADAPTER` | `mock` | `mock` \| `command` \| `http` |
| `AGENT_CMD` | — | CLI to run; `{message}` placeholder or stdin |
| `AGENT_CMD_MODE` | `oneshot` | `oneshot` \| `persistent` |
| `AGENT_CMD_IDLE_MS` | `900` | persistent: silence (after first output) = reply done |
| `AGENT_CMD_WARMUP_MS` | `20000` | persistent: max wait for the first output |
| `AGENT_CMD_PTY` | _(off)_ | `1` to run under a real PTY for TTY-only CLIs |
| `AGENT_CMD_CWD` | cwd | working dir for the command |
| `AGENT_HTTP_URL` | — | OpenAI-compatible endpoint |
| `AGENT_HTTP_KEY` | — | bearer token for the endpoint |
| `AGENT_HTTP_MODEL` | `gpt-3.5-turbo` | model name |
| `AGENT_HTTP_SYSTEM` | — | optional system prompt |
| `APP_TITLE` / `APP_SUBTITLE` | `Talkinter` / `Hermes agent` | header text |

Convenient env loading:

```bash
cp .env.example .env
# edit .env
set -a && . ./.env && set +a && node server.js
```

## Run in the background (recommended)

Instead of keeping two terminals open, install both Talkinter and the Hermes
gateway as user-level systemd services — they run in the background, restart
on failure, and start at boot:

```bash
cd ~/Talkinter
cp .env.example .env   # then edit .env with your AGENT_HTTP_* settings
bash deploy/install.sh
```

Useful commands afterwards:

```bash
systemctl --user status talkinter hermes-gateway   # status of both
journalctl --user -u talkinter -f                  # live Talkinter logs
journalctl --user -u hermes-gateway -f             # live gateway logs
systemctl --user restart talkinter                 # after editing .env
```

The installer also runs `loginctl enable-linger` so the services start at
boot without anyone logging in (it tells you the sudo command if it lacks
permission). Services run as your own user — do not install them as root;
a root gateway reads root's `~/.hermes` config, not yours.

## Exposing it safely

The server binds to `0.0.0.0`, so on a remote box it's reachable on your LAN /
VPS. For anything beyond localhost:

1. Set `AUTH_TOKEN` to a real password.
2. Put it behind HTTPS — e.g. a reverse proxy (Caddy/nginx) or a tunnel
   (`cloudflared`, `tailscale funnel`, `ngrok`).

```caddyfile
# Caddyfile
chat.example.com {
    reverse_proxy localhost:8787
}
```

## How it works

```
browser ──POST /api/chat──▶ server.js ──▶ adapter ──▶ Hermes
        ◀── ndjson stream ──            ◀── stdout / SSE ──
```

The browser streams the reply as newline-delimited JSON events
(`{"type":"chunk"|"done"|"error"}`) and renders Markdown incrementally.
Conversation history is kept in memory per session id and cleared on restart
(swap `lib/sessions.js` for a database if you want persistence).

## Project layout

```
server.js            HTTP server, streaming, static files, auth
config.js            env-var configuration
lib/adapters.js      mock / command / http agent adapters
lib/sessions.js      in-memory conversation store
public/index.html    UI shell
public/app.js        client: streaming, rendering, controls
public/markdown.js   tiny dependency-free Markdown renderer
public/style.css     dark chat theme
```

## License

MIT
