# Changelog

## Unreleased — git safety net and second-opinion review

- **Branch + commit per task** (`webchat.git.autoBranch`, `webchat.git.autoCommit`,
  `webchat.git.branchPrefix`): each task runs on `leechcode/<task>` and every applied turn is
  committed — only the files the agent changed — with a message from the model's summary and a
  `LeechCode-Task:` trailer. A dirty working tree is never committed or stashed silently: LeechCode
  asks whether to branch anyway or stay put. **LeechCode: Revert This Task's Commits** reverts the
  whole task (a revert commit, so later work is kept).
- **Second-opinion review** (`/review`, the **Review** button, or *Review Changes With Another AI*):
  the task's diff goes to a different provider in a fresh chat, which returns a verdict
  (APPROVE / MINOR ISSUES / NEEDS CHANGES) and findings as a card. **Send findings to the author**
  feeds them back to the implementer, telling it to verify each point against the real code.
  A review is always advisory — edits or tools in a reviewer's reply are ignored.
  Configure with `webchat.review.provider` / `webchat.review.maxDiffChars`.
- Git commands now run through one hardened wrapper (`src/workspace/gitCli.ts`): no shell, repository
  config neutralised, disabled in Restricted Mode.

## Unreleased — credentials never leave the machine

- **Secret files are never read** (`.env*`, `*.pem`, `*.key`, keystores, `id_rsa`, `.npmrc`, `.netrc`,
  `.git-credentials`, `.ssh/`, `.aws/`, `credentials`, `secrets.*`, `service-account*.json`): skipped by
  `@codebase`, `@folder`, `@open`, `search` and the `read_file` tool, which now returns a notice
  instead of the contents. `*.example` / `*.sample` / `*.template` files stay readable.
- **Everything sent is scanned** at one choke point — prompts, file context, command output, git
  diffs, index chunks and provider handovers — masking AWS/GitHub/GitLab/Slack/Stripe/npm/OpenAI/
  Anthropic/Google tokens, JWTs, private-key blocks, credentials inside connection strings and
  `Authorization` headers, and the values of `PASSWORD=` / `API_KEY:` style assignments.
- Placeholders, variable expansions and `process.env` lookups are left untouched, so example files and
  ordinary code still make sense to the model, which is told when something was masked.
- New setting `webchat.privacy.redactSecrets` (user-level, default on) and a Settings toggle.

## Unreleased — request tracking and safe provider failover

- Every dispatched prompt now has a tracked lifecycle (sent → submitted → streaming → completed, or
  failed-before-submit / unclear / cancelled), so a failure can be classified instead of guessed.
  **LeechCode: Show Request Status** reports it.
- **Provider failover** (`webchat.failover.mode`: off · safe · always, `webchat.failover.providers`):
  a task can be continued on another provider. It is only automatic when the prompt provably never
  reached the previous provider; after an ambiguous failure LeechCode asks, because replaying could
  duplicate edits and commands.
- **Continuation package:** since a provider's chat history cannot be transferred, the handover is
  built locally — objective, files already changed, tool results, errors, compacted project state,
  permissions and the undo checkpoint — and sent as the first message of a fresh chat, with an
  explicit warning to verify the workspace when the previous provider may already have acted.
- Providers that fail twice in a row are skipped for five minutes when choosing a failover target.
- **Request watchdog** (`webchat.request.timeoutSeconds`, default 120): a page that goes silent now
  fails the request instead of stalling the task forever.
- **Fixed:** the content script reported `submitting` both while *retrying to find the input box* and
  after actually sending, so a prompt that never reached the provider looked accepted (and would have
  blocked a safe failover). It now emits a distinct `submitted` state only when the send control was
  really activated — and a prompt it deliberately did not send (because a reply was still streaming)
  is reported as `prompt-inserted`. Verified against a real browser with a login-wall page, a silent
  page and a working page.

## Unreleased — full access, VS Code context, precise edits, undo

- **Full access mode** (was "Bypass"): edits are applied and commands run with no approvals, with a
  larger tool-loop budget (25 rounds per task, `agent.maxToolIterations`). `/full` switches to it.
  Destructive commands (wiping drives/home/parent folders, formatting disks, force-push,
  `git reset --hard`, `git clean -f`, `curl | sh`, `sudo`, shutdown) still ask first
  (`agent.confirmDangerousCommands`). Downgrades to Auto-edit in untrusted folders. `agent.mode`,
  `agent.maxToolIterations` and `agent.confirmDangerousCommands` are now user-level (application
  scope) settings, so a repository can't enable full access.
- **Undo:** every applied change can be undone — `/undo`, an **Undo** button on the change card, or
  **LeechCode: Undo Last Agent Changes** (40 turns). Files you edited after the agent are only
  overwritten after confirmation. The model is told what was undone.
- **Precise edits:** new `edit` file action with find/replace (`findBase64`/`replaceBase64`), so large
  files don't have to be resent whole. Keeps CRLF files CRLF, tolerates trailing-whitespace
  differences, and refuses ambiguous matches. All changes in a response are validated before anything
  is written; failures are reported back to the model in the same follow-up as the tool output.
- **VS Code context tools** (read-only, run automatically): `diagnostics` (Problems panel),
  `open_editors`, `git_status`, `git_diff`, `symbols` (workspace symbol search) and `references`
  (definition + usages via the language server).
- **More @-mentions:** `@problems`, `@git`, `@open` (all open editors) and `@folder/`.
- **Fixed:** the command card showed "running" in Auto-edit (where commands wait for approval) and
  "approve" in Bypass (where they already ran).
- Full access no longer opens a diff tab for every applied change.
- **Hardening found while reviewing this change:**
  - the agent can no longer write inside `.git/` — a written `.git/config` (fsmonitor, external diff)
    or hook would have made a later "read-only" git tool execute arbitrary commands with no approval;
  - `git_status`/`git_diff` now run with the repository's config neutralised (`--no-ext-diff`,
    `--no-textconv`, no fsmonitor/hooks/pager), stay inside the workspace folder (`-- .`,
    `--literal-pathspecs`, pathspec magic refused) and are disabled in Restricted Mode;
  - a repeated `chat.stream.done` for one reply no longer re-applies its edits or re-runs its tools;
  - a failure part-way through writing now rolls back the files already written, instead of leaving a
    partial apply that the model was told never happened;
  - edits leave text outside the match byte-for-byte (mixed line endings survive) and refuse
    non-UTF-8 files instead of corrupting them; truncated base64 is rejected;
  - the Ask-mode preview uses the same planner as apply, so stacked edits to one file preview
    correctly as a single diff;
  - **View diff** works on older applied cards, a partial undo keeps the rest undoable, declined
    commands are shown as declined, and a paused tool loop carries its output into the next turn;
  - the destructive-command guard now splits command chains and checks every operand, so
    `rm -rf dist /`, `rm -rf ./*`, `rm --recursive --force /`, `git clean --force`, deletes outside
    the project and newline-separated scripts are caught, while `git push … && gh pr create -f`,
    `git restore --staged .` and `npm i sudo-prompt` are no longer flagged.

## Unreleased — fix "every message opens a new tab", bigger sessions

- **Fixed:** once the session budget ran low, *every* following prompt was a "rotate" (usage was never
  reset after rotating), and each rotate opened a brand-new browser tab. Rotation now resets the budget
  for the new chat and reuses the provider's existing tab (navigates/reloads it to a fresh chat).
- **Fixed:** output usage was summed per streaming delta; when a page re-rendered earlier text the
  whole reply was counted again, exhausting the budget after one or two replies. It is now counted once
  per reply.
- **Fixed:** tool results, subagent tasks and repair prompts could trigger a rotate (landing in a new
  chat that never saw the request) or a compaction turn that dropped them. They now always continue in
  the same chat; compact/rotate is decided on user turns only.
- **Fixed:** a scheduled compaction replaced the user's message. The message is now sent, with a request
  for a thorough state summary alongside it.
- **Fixed:** prompts were broadcast to every paired browser, so each opened its own tab and answered
  (duplicate replies). A prompt now goes to one browser — the one with a live chat tab.
- Prompts queued while no browser was connected are only replayed within 30 s, not whenever a browser
  shows up later.
- **Bigger sessions:** the global budget is now 1M context / 1M input / 400k output tokens (was
  150k/120k/30k) and each provider's conversation window decides rotation: ChatGPT 800k chars
  (was 240k), Gemini 3M (was 500k), Qwen 600k (was 120k), DeepSeek 400k (was 200k); Claude stays at
  600k (it hard-stops long chats), AI Studio 4M. Compaction every 10 prompts (was 5).

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
