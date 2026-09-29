# 🪱 LeechCode

**Leech onto your logged-in web AI chat — ChatGPT, Claude, Gemini, Qwen, DeepSeek, Google AI Studio — and run a full agentic coding loop inside your editor. No API keys. No metered tokens.**

LeechCode is a VS Code–compatible extension (VS Code, Cursor, VSCodium, Windsurf, Antigravity and other forks) that uses a **real browser chat session** as the model transport. Your browser already holds a logged-in chat session, so the agent loop runs for free: the IDE owns the context, tools, file edits, diffs and approvals — the browser page is just the LLM.

> **Our belief: AI should be free to use.** Powerful AI assistance shouldn't be locked behind API
> bills and metered tokens. You already have access to capable models through the chat interfaces
> you're logged into — LeechCode simply puts an agentic coding workflow on top of what you already
> have, so anyone can build with AI at no extra cost.

```
Developer
   │  task in the IDE panel
   ▼
LeechCode IDE extension ───────── owns: project context, prompt build, tools,
   │   ▲                                file edits, diffs, approvals, sessions
   │   │  ws://127.0.0.1:53451  (local bridge)
   ▼   │
LeechCode browser extension (MV3)
   │   ▲   types the prompt into the page · streams the reply back
   ▼   │
Web AI chat page (chatgpt.com / claude.ai / gemini / qwen / deepseek / aistudio)
```

## Features

- **Agentic tool loop** — the chat model can request `read_file`, `list_dir`, `search`, `run` (any shell command: git, tests, lint, format) and `spawn_subagent`; LeechCode executes them and feeds results back until the task is done.
- **File edits with real diffs** — every applied edit snapshots the pre-edit file and opens a before→after diff. Inline Apply / View diff / Skip cards.
- **Four agent modes** — `Ask` (approve edits *and* tools), `Auto-edit` (auto-apply edits, approve tools), `Plan` (read-only planning), `Bypass` (full auto).
- **Whole-codebase indexing** — `@codebase` / `/index` delivers your project to the chat; if it's too big for one message it's split into ordered, acknowledged chunks (large files split with `part k/n` markers).
- **Project awareness on every turn** — a compact `PROJECT_STRUCTURE.txt` file tree rides along with each prompt so the model always knows the repo layout and reads files before editing them.
- **Per-provider windows** — configurable per-message and per-conversation character limits for each provider.
- **Live streaming** — the model's explanation streams into the panel; the protocol JSON is hidden. Robust to providers that wrap the block in markdown fences (e.g. DeepSeek).
- **Session management** — token estimates per message, budget meter, compaction prompts, fresh-chat rotation seeded from a compacted summary, and a **Continue a chat** field: paste any previous conversation URL to resume it (recently used chats are tracked automatically).
- **Composer niceties** — paste screenshots from the clipboard, attach files, switch the provider's model from the IDE, toggle on-page features (DeepSeek **Search** / **DeepThink**), ⏹ Stop an in-flight response (the page's generation is stopped and the model is told to disregard it), one-click retry.
- **Bring-your-own vision** — optionally route pasted images through your **local** vision model (Ollama / LM Studio, any OpenAI-compatible endpoint); the image's description/OCR is injected as text, sidestepping web-chat image limits.
- **Resilience** — login/upsell/cookie overlays are auto-dismissed, blocked submits retry automatically, and chunked deliveries never interrupt an in-flight response.
- **No telemetry.** Everything runs on `127.0.0.1`.

---

## Installation

> Full step-by-step (per IDE, with troubleshooting): **[docs/installation.md](docs/installation.md)**

### Prerequisites

- **Node.js 20+** (22+ recommended — the test suite uses the built-in WebSocket client) and **pnpm 9+**
- A **Chromium-based browser**: Chrome, Brave, Edge or Chromium (the browser extension is Manifest V3; Firefox is not supported yet)
- A VS Code–compatible editor: VS Code, Cursor, VSCodium, Windsurf, Antigravity, …

### 1. Build the extension

```bash
git clone git@github.com:fariqueparammel/LeechCode.git
cd LeechCode
pnpm install
pnpm run compile     # typecheck + bundle
pnpm run package     # -> webchat-<version>.vsix
```

### 2. Install the VSIX into your editor

```bash
code --install-extension ./webchat-*.vsix      # VS Code
cursor --install-extension ./webchat-*.vsix    # Cursor
```

Any fork works via its CLI or **Extensions: Install from VSIX…** in the command palette.

This installs into your **existing editor** (current profile) — it does **not** open a new window or a separate instance. If the editor is already open, just reload it (command palette → *Developer: Reload Window*); a **LeechCode** icon then appears in the Activity Bar. Windows opened later have it automatically.

### 3. Load the browser extension

1. Open `chrome://extensions` (or `brave://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this repo's [`browser-extension/`](browser-extension/) folder.

### 4. Connect and go

1. In the editor, open the **LeechCode** panel. The status strip shows the bridge state.
2. **Pair once:** on first start the editor generates a private pairing token (kept in the OS keychain). Click **Copy pairing token** on the toast (or run **LeechCode: Copy Bridge Pairing Token**), then click the WebChat Bridge toolbar icon in the browser, paste it and hit **Save & connect**. The options page shows the connection state.
3. Click **open chat tab** (or just open chatgpt.com / claude.ai / … in the browser that has the extension). The extension connects to `ws://127.0.0.1:53451` — the dot turns green: `1 browser connected`.
4. Log into the chat provider once in that browser (your session persists).
5. Type a task in the panel and hit **Send**. For the fully hands-off loop, enable `webchat.browser.autoSubmit` in Settings (⚙ in the panel).

---

## Using LeechCode

| In the composer | What it does |
| --- | --- |
| `@somefile` | attach specific workspace files as context |
| `@folder/` | attach every file in a folder (type part of its name) |
| `@problems` | attach the Problems panel (compiler / linter errors and warnings) |
| `@git` | attach `git status` + the uncommitted diff |
| `@open` | attach every file open in the editor |
| `@codebase` or `/index` | index the whole workspace (chunked automatically if too large) |
| `/ask` `/auto` `/plan` `/full` | switch agent mode (`/full` = full access, no approvals) |
| `/undo` | undo the agent's last file changes (also: the **Undo** button on a change card, or **LeechCode: Undo Last Agent Changes**) |
| `/compact` `/clear` `/open` `/close` | compact session · reset · open/close the chat browser |
| paste a screenshot / `＋` | attach images & files (optionally analyzed by your local vision model) |
| `model…` dropdown | switch the model on the provider page |
| 🔍 / 🧠 pills | toggle provider features (e.g. DeepSeek Search / DeepThink) |
| 🔗 Continue a chat | paste a previous conversation URL to resume it |

**Agent modes**

| Mode | File edits | Tools / shell commands |
| --- | --- | --- |
| Ask | review diff, then apply | approve each batch |
| Auto-edit | applied automatically | approve each batch |
| Plan | none | read-only exploration only |
| Full access | applied automatically | run automatically — no approvals |

In every mode the agent can read the project on its own: `read_file`, `list_dir`, `search`, plus VS Code's view of it — `diagnostics` (Problems panel), `open_editors`, `git_status` / `git_diff`, `symbols` (find a class/function by name) and `references` (definition + all usages). It edits existing files with small find/replace **edits** instead of resending whole files; if an edit doesn't match, nothing from that response is written and the model is told why so it can retry.

**Full access** lets the agent work on its own until the task is done: edit → run build/tests → check problems → fix, up to 25 tool rounds per task (`agent.maxToolIterations`). Safety nets:

- every applied change can be undone (`/undo`, the card's **Undo**, 40 turns); undo asks before overwriting a file you changed afterwards;
- the agent can never write inside `.git/` (a written `.git/config` or hook would run code behind your back), and the git tools run with the repository's own config neutralised and are disabled in Restricted Mode;
- a response is applied only if *all* of its changes are valid, and a failure while writing rolls the files back;
- commands that could destroy data outside the project — deleting a drive/home/parent folder, formatting disks, force-push, `git reset --hard`, `git clean -f`, `curl … | sh`, `sudo`, shutdown — still ask first (`agent.confirmDangerousCommands`);
- it only runs in trusted folders (in Restricted Mode it behaves like Auto-edit), and the mode is a user setting, so a repository's `.vscode/settings.json` can't switch it on;
- diff tabs aren't opened automatically in full access (use **View diff** on the card).

> ⚠️ Full access means text coming from a web page decides which commands run on your computer. Use it on projects you have committed to git, and switch back to Ask for unfamiliar code.

**Key settings** (all under the `webchat.*` namespace, editable in the in-panel ⚙ Settings or VS Code settings): `defaultProvider`, `agent.mode`, `agent.maxToolIterations`, `agent.confirmDangerousCommands`, `browser.autoSubmit`, `provider.maxMessageChars` / `provider.maxSessionChars` (per-provider windows), `index.chunked` / `index.maxChunks`, `context.maxIndexChars` / `context.maxTreeChars`, `diff.showOnApply`, `vision.*` (local image→text), `session.*` (budget / compaction / rotation), `bridge.port` / `bridge.token`.

> 🔐 The bridge only accepts connections that present the per-install pairing token, and refuses WebSocket/HTTP requests coming from web-page origins. `bridge.token` is an optional advanced override (≥ 24 chars; the old `webchat-dev-token` is rejected). If you change `bridge.port`, set the same port on the browser extension's options page. **LeechCode: Regenerate Bridge Pairing Token** rotates the token and disconnects every paired browser.

## Using any other AI chat site

Not limited to the built-ins — any web chat with a message box works:

1. In the editor: ⚙ Settings → **Custom AI sites** → enter a name and the chat URL (e.g. `Z.ai`, `https://chat.z.ai/`) → **Add**. (Or edit `webchat.customProviders` in user settings.)
2. In the browser: click the WebChat Bridge toolbar icon → under **Custom AI sites** click **Allow** for it (Chrome asks once per site).
3. Pick it in the panel's provider dropdown and send as usual.

The extension guesses the message box, the Send button (even icon-only ones) and the reply area. If it guesses wrong, right-click the correct element on that page → **WebChat Bridge** → *Use as chat input / Send button / assistant reply*. Picks are saved per site and can be reset on the options page. This also works for fixing a built-in provider after a redesign.

## Your secrets stay on your machine

Everything LeechCode sends lands in a third-party web page, so credentials are held back in two layers (`webchat.privacy.redactSecrets`, on by default):

1. **Files that exist to hold secrets are never read** — `.env` and `.env.*`, `*.pem`, `*.key`, `*.pfx`, `*.p12`, keystores, `id_rsa`/`id_ed25519`, `.npmrc`, `.netrc`, `.git-credentials`, `.ssh/`, `.aws/`, `credentials`, `secrets.*`, `service-account*.json`. They are skipped by `@codebase`, `@folder`, `@open`, `search` and `read_file`; the agent gets a short notice instead of the contents. `*.example` / `*.sample` / `*.template` files stay fully readable.
2. **Everything actually sent is scanned** — prompts, file context, command output, git diffs and provider handovers. Recognisable credentials are masked as `***REDACTED***`: AWS keys, GitHub/GitLab/Slack/Stripe/npm/OpenAI/Anthropic/Google tokens, JWTs, private-key blocks, passwords inside connection strings and `Authorization:` headers, plus the *value* of assignments such as `DB_PASSWORD=…` or `"apiKey": "…"`.

Placeholders are deliberately left alone, so documentation and code keep working for the model: `API_KEY=your-key-here`, `TOKEN=${GITHUB_TOKEN}`, `password = process.env.DB_PASSWORD`, `sk_live_replace_me`. The model is told when something was masked, so it doesn't try to guess the value.

> This is a safety net, not a guarantee — a credential in an unusual format can still slip through. Treat a chat you drive this way as you would any external service.

## When a request fails (provider failover)

A browser page is a lossy transport: a tab closes, a login wall appears, the page goes quiet. LeechCode tracks how far each request got, because that decides what is safe to do next:

| Where it failed | What happens |
| --- | --- |
| The prompt never reached the provider (no browser connected, no input box, login wall, page still retrying) | **Safe** — the task can be handed to another provider automatically |
| The prompt was submitted, then the page failed or went silent | **Unclear** — the provider may already have edited files or run commands, so it is never resent automatically; LeechCode asks first |

Set `webchat.failover.mode` (⚙ Settings → Agent) to `off` (just tell me), `safe` (hand over only when nothing was sent) or `always` (also offer after an unclear failure). `webchat.failover.providers` sets the order to try, and a provider that fails twice in a row is skipped for five minutes.

Because a provider's own chat history can't be moved, the handover is built locally and sent as the first message of a fresh chat: the objective, files already changed, tool output already gathered, the errors, the compacted project state, and — after an unclear failure — an instruction to check the workspace with `read_file`/`git_diff`/`diagnostics` before changing anything. **LeechCode: Show Request Status** shows the current state; `webchat.request.timeoutSeconds` (default 120) bounds how long a silent page is waited for.

## When a provider changes its page

Chat sites update their HTML often. Everything page-specific lives in **one file** — `browser-extension/src/content.js` — and **[docs/provider-adapters.md](docs/provider-adapters.md)** explains exactly which selector list to edit for each symptom (input not found, won't submit, no streaming, pop-up not dismissed, Stop, model switch), how to find a stable selector in DevTools in ~2 minutes, and how to reload. You can fix a provider yourself without waiting for a LeechCode update.

## Development

```bash
pnpm run compile             # tsc (extension host) + esbuild (webview React app)
pnpm test                    # node --test unit suite
pnpm run verify:tooling      # streaming + tool-protocol end-to-end (headless)
pnpm run verify:chunked-index# chunked indexing over a real bridge (headless)
pnpm run package             # build the VSIX
```

Repo map: `src/` (extension host: bridge, agent protocol & tools, prompt builders, controller, webview host) · `webview-ui/` (React chat panel) · `browser-extension/` (MV3 page bridge) · `scripts/` (dev launchers & verification harnesses) · `docs/` (architecture, provider adapters, installation). The dev launcher scripts (`pnpm run dev*`) are tuned for the author's machine (Antigravity + Brave paths) — the manual steps above work anywhere.

Architecture deep-dive: [docs/architecture.md](docs/architecture.md).

## Fair use

LeechCode automates *your own* logged-in browser session. Automating a chat UI may be against some providers' terms of service — use your own account, keep volumes reasonable, and use it responsibly. This project ships no telemetry and never sends your code anywhere except to the chat page you point it at.

## License

[MIT](LICENSE)
