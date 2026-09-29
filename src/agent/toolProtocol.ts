import { extractAgentJson } from "./responseFormat";
import type { TextEdit } from "./fileEdits";

export interface AgentFileChange {
  readonly path: string;
  readonly action: "write" | "delete" | "edit";
  /** Full new content (write). */
  readonly content?: string;
  /** Targeted find/replace edits applied to the current file (edit). */
  readonly edits?: readonly TextEdit[];
}

/**
 * A structured tool the model can ask the IDE to run. Read-only tools (read_file/list_dir/search)
 * are executed automatically and safely (workspace-scoped, capped); `run` is a shell command gated
 * by the agent mode. Results are fed back to the chat as the next message, forming the tool loop.
 */
export type AgentToolRequest =
  | { readonly name: "read_file"; readonly path: string; readonly startLine?: number; readonly endLine?: number }
  | { readonly name: "list_dir"; readonly path: string }
  | { readonly name: "search"; readonly query: string; readonly glob?: string }
  | { readonly name: "diagnostics"; readonly path?: string }
  | { readonly name: "open_editors" }
  | { readonly name: "git_status" }
  | { readonly name: "git_diff"; readonly path?: string; readonly staged?: boolean }
  | { readonly name: "symbols"; readonly query: string }
  | { readonly name: "references"; readonly path: string; readonly symbol: string; readonly line?: number }
  | { readonly name: "run"; readonly command: string }
  | { readonly name: "spawn_subagent"; readonly task: string; readonly context?: readonly string[] };

export type AgentToolName = AgentToolRequest["name"];

export interface AgentResponse {
  readonly summary: string;
  readonly files: readonly AgentFileChange[];
  readonly commands: readonly string[];
  readonly tools: readonly AgentToolRequest[];
  readonly nextSteps: readonly string[];
}

const START_MARKER = "<webchat_agent_response>";
const END_MARKER = "</webchat_agent_response>";
const MAX_REPAIR_CONTEXT_CHARS = 12000;

export function buildAgentToolInstructions(input: {
  readonly maxContextTokens: number;
  readonly compactEveryPrompts: number;
  readonly action: "continue" | "compact" | "rotate";
  readonly mode?: "ask" | "auto" | "plan" | "bypass";
  readonly previousSummary?: string;
  /** When false (inside a subagent), the spawn_subagent tool is not advertised (depth cap). */
  readonly allowSubagents?: boolean;
  /** Provider the prompt is sent to — adds provider-specific format guidance (e.g. Gemini). */
  readonly providerId?: string;
}): string {
  const previousSummary = input.previousSummary
    ? `\nPrevious compacted session state:\n${input.previousSummary}\n`
    : "";
  const mode = input.mode ?? "ask";
  // The agent mode manipulates what we ask the model to produce.
  const modeInstruction =
    mode === "plan"
      ? "MODE: PLAN. Do NOT write or change any files this turn. Respond with a concise, numbered implementation plan in `summary` and `nextSteps`, and return an empty `files` array. The user will switch to an edit mode to apply it."
      : mode === "bypass"
        ? "MODE: FULL ACCESS. The developer has given you full autonomy: your edits are applied and your tools (including run) execute immediately, with no approval step. Work like a senior engineer on their machine — explore (read_file/search/symbols/diagnostics), make the edits, then verify (build/tests/diagnostics) and fix what fails, looping until the task is really done. Keep changes scoped to the task, never touch files outside the workspace, and don't run destructive or irreversible commands (deleting outside build folders, force-pushing, resetting git history) unless the user explicitly asked."
      : mode === "auto"
        ? "MODE: AUTO-EDIT. Make the complete edits needed to fully satisfy the task. The IDE applies them automatically (shell commands still need the user's approval), so include every change required to run."
        : "MODE: ASK. Propose the complete edits as file writes. The user will review a diff and approve before anything is applied, so make the changes self-contained and easy to review.";

  const allowSubagents = input.allowSubagents ?? true;
  const toolsDoc =
    mode === "plan"
      ? "You may READ to plan (read_file, list_dir, search, diagnostics, open_editors, git_status, git_diff, symbols, references) but must NOT run shell commands or edit files this turn."
      : [
          "You have a full coding toolbelt. Request tools in a \"tools\" array; the IDE executes them and sends you their output as the next message so you can read results and continue (a tool loop). Available tools:",
          "  • {\"name\":\"read_file\",\"path\":\"rel/path\"} — read a file (optional \"startLine\"/\"endLine\" for a slice).",
          "  • {\"name\":\"list_dir\",\"path\":\"rel/dir\"} — list a directory's entries.",
          "  • {\"name\":\"search\",\"query\":\"regex or text\",\"glob\":\"**/*.ts\"} — search file contents (glob optional).",
          "  • {\"name\":\"diagnostics\",\"path\":\"rel/path\"} — the editor's Problems panel: compiler/linter errors and warnings (omit path for the whole workspace). Check it after editing.",
          "  • {\"name\":\"open_editors\"} — files the developer has open, which one is active, unsaved changes and the selected lines.",
          "  • {\"name\":\"git_status\"} / {\"name\":\"git_diff\",\"path\":\"rel/path\",\"staged\":false} — current branch, changed files and the uncommitted diff (path/staged optional).",
          "  • {\"name\":\"symbols\",\"query\":\"UserService\"} — find classes/functions/variables by name across the workspace (language server).",
          "  • {\"name\":\"references\",\"path\":\"rel/path\",\"symbol\":\"login\",\"line\":42} — definition and every usage of a symbol that appears in that file (line optional, picks the nearest occurrence).",
          "  • {\"name\":\"run\",\"command\":\"npm test\"} — run ANY shell command in the workspace root: git (e.g. `git diff`, `git status`), build, run, tests, linters (eslint), formatters (prettier), package managers, etc.",
          allowSubagents
            ? "  • {\"name\":\"spawn_subagent\",\"task\":\"self-contained instruction\",\"context\":[\"rel/path\"]} — delegate a focused sub-task to a fresh isolated agent that only sees the task + the files you list. It runs its own tool loop and returns a concise result summary to you. Use it to parallelize/scope large work; a subagent cannot itself spawn subagents."
            : "",
          `Read-only tools (read_file, list_dir, search, diagnostics, open_editors, git_status, git_diff, symbols, references) run automatically. \`run\` commands${allowSubagents ? " and spawn_subagent are" : " are"} approved per agent mode. The legacy "commands":["…"] array is still accepted and equals a list of run tools.`,
          `Explore with read_file/list_dir/search before editing, verify with \`run\` (build/tests/lint) afterward${allowSubagents ? ", and delegate independent chunks with spawn_subagent" : ""}. Stop requesting tools once the task is done and verified.`
        ]
          .filter(Boolean)
          .join("\n");

  const providerNote =
    input.providerId === "gemini" || input.providerId === "aistudio"
      ? "PLATFORM NOTE (Gemini): reply in plain text/markdown only — no canvas, no tool_code, no code-execution blocks. Put the response block at the END of your reply, after your short explanation."
      : "";

  return [
    "You are driving an IDE through WebChat's coding tools.",
    modeInstruction,
    providerNote,
    // Streaming UX: the IDE hides the JSON block and streams the prose around it to the user live.
    "IMPORTANT: Begin your reply with 1–4 short sentences in plain language explaining what you are about to do and why. This prose streams live to the developer, so never start with the JSON block and never leave the prose empty. After the explanation, output the single marked block below.",
    toolsDoc,
    "Return edits and tool requests only through the exact JSON block shown below. Prefer the plain <webchat_agent_response> markers with no markdown fences; if your platform forces code formatting, a ```json fenced block containing the same JSON object is also accepted. Never HTML-escape the markers and never put them inside backticks.",
    "Request tools ONLY via the \"tools\" array in that JSON. Do NOT emit tool_code / python / function-call code blocks — the IDE does not execute those.",
    "Use workspace-relative paths only. Never use absolute paths or parent-directory traversal.",
    "A PROJECT_STRUCTURE.txt listing the repository's files is included so you know the layout. Before editing an EXISTING file, first read_file it and work from its ACTUAL current content — never rewrite a file you have not read, or you will lose existing content.",
    "To change part of an EXISTING file, prefer a targeted edit (much smaller than resending the file): {\"path\":\"src/app.ts\",\"action\":\"edit\",\"edits\":[{\"findBase64\":\"<base64 of exact current text>\",\"replaceBase64\":\"<base64 of new text>\"}]}. Each find must match the current file exactly once — copy it from read_file and include a few surrounding lines to make it unique (or add \"all\":true to replace every occurrence). Plain \"find\"/\"replace\" strings are accepted for short, JSON-safe text. If an edit fails, the IDE tells you why in the next message and applies nothing from that response.",
    "To create a new file or rewrite a small one, use {\"path\":\"relative/path\",\"action\":\"write\",\"contentBase64\":\"UTF-8 base64 full file contents\"} — a write replaces the whole file.",
    "Prefer the Base64 fields for code. The IDE also accepts plain content/find/replace strings for tiny plain-text snippets, but raw code strings are easy to make invalid JSON.",
    "The marked block must be valid JSON that can be parsed with JSON.parse.",
    "For deletions, use {\"path\":\"relative/path\",\"action\":\"delete\"}.",
    `Current session action: ${input.action}.`,
    `Configured total context limit: ${input.maxContextTokens} approximate tokens.`,
    `Compaction cadence: every ${input.compactEveryPrompts} prompts.`,
    input.action === "compact"
      ? "This turn also compacts the session: make summary a thorough compacted development state. If the user gave a task, still complete it (file edits and tools are allowed)."
      : "",
    input.action === "rotate"
      ? "This turn is for a fresh chat session. Start from the previous summary, then continue the work."
      : "",
    previousSummary,
    "Required response shape (prose first, then this block):",
    START_MARKER,
    "{",
    "  \"summary\": \"short durable plan/state for future chats\",",
    "  \"files\": [",
    "    {\"path\":\"demo/example/index.html\",\"action\":\"write\",\"contentBase64\":\"PG1haW4+SGVsbG88L21haW4+\"},",
    "    {\"path\":\"src/config.ts\",\"action\":\"edit\",\"edits\":[{\"find\":\"retries: 3\",\"replace\":\"retries: 5\"}]}",
    "  ],",
    "  \"tools\": [{\"name\":\"read_file\",\"path\":\"src/app.ts\"}, {\"name\":\"run\",\"command\":\"npm test\"}],",
    "  \"nextSteps\": [\"short next step\"]",
    "}",
    END_MARKER
  ].filter(Boolean).join("\n");
}

export function parseAgentResponse(text: string): AgentResponse | undefined {
  const rawJson = extractMarkedJson(text);

  if (!rawJson) {
    return undefined;
  }

  const parsed = JSON.parse(rawJson) as unknown;

  if (!isRecord(parsed)) {
    throw new Error("Agent response must be a JSON object.");
  }

  const summary = readString(parsed, "summary", "");
  const files = readFileChanges(parsed.files);
  const commands = readCommands(parsed.commands);
  const tools = readToolRequests(parsed.tools, commands);
  const nextSteps = readNextSteps(parsed.nextSteps);

  return {
    summary,
    files,
    commands,
    tools,
    nextSteps
  };
}

/**
 * Parse the structured `tools` array, plus fold any legacy `commands` strings in as `run` tools so
 * the controller has one ordered list to execute. Unknown/invalid tool entries are dropped.
 */
function readToolRequests(value: unknown, commands: readonly string[]): AgentToolRequest[] {
  const tools: AgentToolRequest[] = [];

  if (Array.isArray(value)) {
    for (const item of value) {
      const tool = readToolRequest(item);
      if (tool) {
        tools.push(tool);
      }
    }
  }

  // Legacy: a bare "commands" array is equivalent to a list of run tools. Only fold them in if the
  // model didn't already express them as run tools (avoid double-running the same command).
  const alreadyRunning = new Set(
    tools.filter((t): t is Extract<AgentToolRequest, { name: "run" }> => t.name === "run").map((t) => t.command)
  );
  for (const command of commands) {
    if (!alreadyRunning.has(command)) {
      tools.push({ name: "run", command });
    }
  }

  return tools;
}

function readToolRequest(item: unknown): AgentToolRequest | undefined {
  if (!isRecord(item) || typeof item.name !== "string") {
    return undefined;
  }
  switch (item.name) {
    case "read_file": {
      if (typeof item.path !== "string" || !item.path.trim()) {
        return undefined;
      }
      const startLine = toPositiveInt(item.startLine);
      const endLine = toPositiveInt(item.endLine);
      return { name: "read_file", path: item.path.trim(), startLine, endLine };
    }
    case "list_dir":
      return typeof item.path === "string" ? { name: "list_dir", path: item.path.trim() } : undefined;
    case "search": {
      if (typeof item.query !== "string" || !item.query.trim()) {
        return undefined;
      }
      const glob = typeof item.glob === "string" && item.glob.trim() ? item.glob.trim() : undefined;
      return { name: "search", query: item.query, glob };
    }
    case "diagnostics":
      return { name: "diagnostics", path: optionalString(item.path) };
    case "open_editors":
      return { name: "open_editors" };
    case "git_status":
      return { name: "git_status" };
    case "git_diff":
      return { name: "git_diff", path: optionalString(item.path), staged: item.staged === true ? true : undefined };
    case "symbols": {
      const query = optionalString(item.query);
      return query ? { name: "symbols", query } : undefined;
    }
    case "references": {
      const path = optionalString(item.path);
      const symbol = optionalString(item.symbol);
      return path && symbol ? { name: "references", path, symbol, line: toPositiveInt(item.line) } : undefined;
    }
    case "run":
      return typeof item.command === "string" && item.command.trim()
        ? { name: "run", command: item.command.trim() }
        : undefined;
    case "spawn_subagent": {
      if (typeof item.task !== "string" || !item.task.trim()) {
        return undefined;
      }
      const context = Array.isArray(item.context)
        ? item.context.filter((p): p is string => typeof p === "string" && p.trim().length > 0).map((p) => p.trim())
        : undefined;
      return { name: "spawn_subagent", task: item.task.trim(), context };
    }
    default:
      return undefined;
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function toPositiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined;
}

function readCommands(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => item.trim());
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return [value.trim()];
  }
  return [];
}

export function buildAgentResponseRepairPrompt(input: {
  readonly parseError: string;
  readonly invalidResponse: string;
}): string {
  return [
    "Your previous WebChat agent tool response could not be parsed by the IDE.",
    `Parser error: ${input.parseError}`,
    "",
    "Return only a corrected WebChat agent response block (a ```json fenced block with the same JSON is also accepted).",
    "The block must be valid JSON parseable by JSON.parse.",
    "For every write, use contentBase64 with UTF-8 base64 file contents; for edits use findBase64/replaceBase64. Do not use raw strings for code.",
    "Use this exact shape:",
    START_MARKER,
    "{",
    "  \"summary\": \"short durable plan/state for future chats\",",
    "  \"files\": [",
    "    {\"path\":\"demo/example/index.html\",\"action\":\"write\",\"contentBase64\":\"PG1haW4+SGVsbG88L21haW4+\"}",
    "  ],",
    "  \"nextSteps\": [\"short next step\"]",
    "}",
    END_MARKER,
    "",
    "Invalid previous response:",
    truncateForRepair(input.invalidResponse)
  ].join("\n");
}

function extractMarkedJson(text: string): string | undefined {
  // Lenient: prefer the <webchat_agent_response> markers, but also accept a ```json-fenced or bare
  // JSON object of the right shape (models like DeepSeek fence the JSON and drop the markers).
  return extractAgentJson(text);
}

function readFileChanges(value: unknown): AgentFileChange[] {
  const items = Array.isArray(value)
    ? value
    : isRecord(value)
      ? [value]
      : [];

  if (items.length === 0) {
    return [];
  }

  return items.map((item) => {
    if (!isRecord(item)) {
      throw new Error("Each file change must be a JSON object.");
    }

    const path = readString(item, "path");
    const action = item.action;

    if (action !== "write" && action !== "delete" && action !== "edit") {
      throw new Error(`Unsupported file action for ${path}.`);
    }

    if (action === "edit") {
      return { path, action, edits: readTextEdits(item, path) };
    }

    if (action === "write") {
      return {
        path,
        action,
        content: readWriteContent(item)
      };
    }

    return {
      path,
      action
    };
  });
}

/**
 * Edits come as {"edits":[{find|findBase64, replace|replaceBase64, all?}, …]} or, for a single edit,
 * the same fields directly on the file entry.
 */
function readTextEdits(item: Record<string, unknown>, path: string): TextEdit[] {
  const raw = Array.isArray(item.edits) ? item.edits : [item];
  const edits = raw.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`Edit ${index + 1} for ${path} must be a JSON object.`);
    }
    const find = readEncodedText(entry, "find");
    const replace = readEncodedText(entry, "replace");
    if (find === undefined || replace === undefined) {
      throw new Error(`Edit ${index + 1} for ${path} needs "find"/"findBase64" and "replace"/"replaceBase64".`);
    }
    return entry.all === true ? { find, replace, all: true } : { find, replace };
  });
  if (edits.length === 0) {
    throw new Error(`Edit action for ${path} has no edits.`);
  }
  return edits;
}

function readEncodedText(value: Record<string, unknown>, property: string): string | undefined {
  const encoded = value[`${property}Base64`];
  if (typeof encoded === "string") {
    return decodeBase64Strict(encoded, `${property}Base64`);
  }
  const plain = value[property];
  return typeof plain === "string" ? plain : undefined;
}

/**
 * Node's base64 decoder silently ignores stray characters and decodes truncated input to a prefix.
 * For an edit that would mean matching a shortened "find" and leaving old code behind, so the value
 * is re-encoded and compared instead.
 */
function decodeBase64Strict(encoded: string, field: string): string {
  const buffer = Buffer.from(encoded, "base64");
  const normalized = encoded.replace(/\s+/g, "");
  if (buffer.toString("base64").replace(/=+$/, "") !== normalized.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/")) {
    throw new Error(`${field} is not valid base64 (it looks truncated or corrupted) — re-send the whole value.`);
  }
  return buffer.toString("utf8");
}

function readNextSteps(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((step): step is string => typeof step === "string");
  }

  if (typeof value === "string" && value.trim()) {
    return [value];
  }

  return [];
}

function readWriteContent(value: Record<string, unknown>): string {
  const encoded = value.contentBase64;

  if (typeof encoded === "string") {
    return decodeBase64Strict(encoded, "contentBase64");
  }

  return readString(value, "content");
}

function truncateForRepair(text: string): string {
  if (text.length <= MAX_REPAIR_CONTEXT_CHARS) {
    return text;
  }

  const head = text.slice(0, Math.floor(MAX_REPAIR_CONTEXT_CHARS / 2));
  const tail = text.slice(-Math.floor(MAX_REPAIR_CONTEXT_CHARS / 2));
  return `${head}\n\n...[truncated for repair prompt]...\n\n${tail}`;
}

function readString(value: Record<string, unknown>, property: string, fallback?: string): string {
  const field = value[property];

  if (typeof field === "string") {
    return field;
  }

  if (fallback !== undefined) {
    return fallback;
  }

  throw new Error(`Agent response requires a ${property} string.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
