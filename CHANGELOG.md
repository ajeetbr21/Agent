# Changelog

## Unreleased — custom AI sites

- **Use any web AI chat:** ⚙ Settings → *Custom AI sites* (setting `webchat.customProviders`) adds any
  chat URL as a provider. Only a name + URL are required.
- Browser extension asks for access per site (options page → **Allow**) via optional host permissions
  and registers its content script there at runtime; already-open tabs are injected on grant.
- Generic detection for unknown sites, including unlabeled icon-only Send buttons next to the input.
- Right-click → **WebChat Bridge** → *Use as chat input / Send button / assistant reply* saves a
  per-site selector override (built-ins too); reset from the options page.
- Prompts now go to a tab of the targeted provider's host instead of whichever provider tab was active.

## Unreleased — secure bridge pairing

- **Security:** the bridge no longer uses the shared, public `webchat-dev-token`. Each install
  generates a random 256-bit pairing token on first start and keeps it in the OS keychain
  (VS Code SecretStorage), never in `settings.json`.
- New commands **LeechCode: Copy Bridge Pairing Token** / **Regenerate Bridge Pairing Token**, and
  matching buttons in ⚙ Settings → Bridge (the token itself is no longer shown or editable there).
- Browser extension: new options page (toolbar icon) to paste the token and port, with live status
  (connected / token rejected / IDE not reachable). Opens automatically on first install.
- Bridge server: constant-time token comparison; WebSocket upgrades and HTTP requests from web-page
  origins are refused (403); unauthenticated `/health` only reports liveness and client count.
- `webchat.bridge.token` is now an optional application-scope override (≥ 24 chars).
- `scripts/verify-live-bridge.mjs` requires the token (argument or `WEBCHAT_BRIDGE_TOKEN`).

## 0.0.17 — initial public release

First public cut of **LeechCode** — drive a real, logged-in web AI chat (ChatGPT, Claude, Gemini,
Qwen, DeepSeek, Google AI Studio) as the model behind an agentic coding loop in your editor.

- Activity-bar chat panel (React): live streaming, inline Apply/Preview/Skip diff cards, token
  counts per message, ⏹ Stop, retry, session budget meter.
- Agent tool loop: `read_file` / `list_dir` / `search` / `run` (shell) / `spawn_subagent`, with
  results fed back to the chat automatically.
- Four agent modes: Ask · Auto-edit · Plan · Bypass.
- Whole-codebase indexing (`/index`, `@codebase`) with automatic chunked delivery for large repos;
  per-provider per-message and per-conversation character windows.
- Project structure sent with every turn; before→after diffs on every applied edit.
- Composer: paste screenshots, attach files, on-page model switcher, provider feature toggles
  (e.g. DeepSeek Search / DeepThink); optional local vision model (image → text) via any
  OpenAI-compatible endpoint.
- Continue-a-chat: paste a previous conversation URL to resume it; recently used chats tracked.
- Resilience: login/upsell overlay dismissal, submit retries, never interrupts an in-flight
  generation; robust parsing of fenced/bare tool JSON across providers.
- Local-only bridge (`127.0.0.1:53451`), no telemetry.

## 0.0.1

- Initial WebChat extension scaffold.
