/**
 * A provider's conversation history cannot be moved to another provider, so everything needed to
 * carry on must be held locally and re-sent as text. That package is built here.
 *
 * It is deliberately explicit about what is already DONE, because the new provider must not redo
 * edits or re-run commands that the previous one already applied.
 *
 * Pure (no vscode import) so it is unit-testable.
 */

export interface ContinuationPackage {
  /** What the user originally asked for. */
  readonly objective: string;
  /** Where the work stopped, in plain words. */
  readonly phase: string;
  readonly workspaceName?: string;
  /** Files already changed by this task, newest last. */
  readonly changedFiles: readonly { readonly path: string; readonly action: string }[];
  /** Files worth reading again (attached context, recently inspected). */
  readonly relevantFiles: readonly string[];
  /** Tool calls already made and their (truncated) results. */
  readonly toolResults: readonly { readonly label: string; readonly output: string }[];
  /** Why the previous provider stopped. */
  readonly errors: readonly string[];
  /** Compacted project summary from the previous chat, if any. */
  readonly summary?: string;
  /** Approvals/permissions in force, so the new provider knows what it may do. */
  readonly permissions: string;
  /** Undo checkpoint the user can roll back to. */
  readonly checkpoint?: string;
  /** Whether the failed request could already have been acted on by the previous provider. */
  readonly previousRequest: {
    readonly providerId: string;
    readonly phase: string;
    readonly mayHaveActed: boolean;
  };
}

const MAX_TOOL_OUTPUT_CHARS = 1500;
const MAX_TOOL_RESULTS = 6;
const MAX_LISTED_FILES = 40;

/**
 * Render the package as a prompt for a *fresh* chat on another provider. The tone is instructional
 * because this is the first message that provider sees — it has no history at all.
 */
export function buildContinuationPrompt(pack: ContinuationPackage): string {
  const lines: string[] = [
    "You are taking over a coding task that another assistant started in a different chat. That chat's history is not available, so this message is the complete handover. Do not greet or summarise — continue the work.",
    "",
    "<handover>",
    `<objective>${pack.objective.trim() || "(not recorded)"}</objective>`,
    `<status>${pack.phase}</status>`
  ];

  if (pack.workspaceName) {
    lines.push(`<workspace>${pack.workspaceName}</workspace>`);
  }
  lines.push(`<permissions>${pack.permissions}</permissions>`);

  if (pack.summary?.trim()) {
    lines.push("<project_state>", pack.summary.trim(), "</project_state>");
  }

  if (pack.changedFiles.length > 0) {
    lines.push(
      "<already_changed>",
      "These files were ALREADY changed for this task. Do not redo those edits — read the files to see their current content before changing them further.",
      ...pack.changedFiles.slice(-MAX_LISTED_FILES).map((file) => `- ${file.action}: ${file.path}`),
      "</already_changed>"
    );
  }

  if (pack.relevantFiles.length > 0) {
    lines.push(
      "<relevant_files>",
      ...pack.relevantFiles.slice(0, MAX_LISTED_FILES).map((path) => `- ${path}`),
      "</relevant_files>"
    );
  }

  if (pack.toolResults.length > 0) {
    lines.push("<work_already_done>");
    for (const result of pack.toolResults.slice(-MAX_TOOL_RESULTS)) {
      lines.push(`# ${result.label}`, truncate(result.output, MAX_TOOL_OUTPUT_CHARS));
    }
    lines.push(
      "Commands listed above have already run — do not repeat them unless you need fresh output.",
      "</work_already_done>"
    );
  }

  if (pack.errors.length > 0) {
    lines.push("<why_the_previous_chat_stopped>", ...pack.errors.map((error) => `- ${error}`), "</why_the_previous_chat_stopped>");
  }

  lines.push(
    "<previous_request>",
    `The last request was sent to ${pack.previousRequest.providerId} and ended as: ${pack.previousRequest.phase}.`,
    pack.previousRequest.mayHaveActed
      ? "IMPORTANT: that provider may already have produced edits or commands for this request. Before acting, use read_file / git_diff / diagnostics to check the current state of the workspace, and only make the changes that are still missing."
      : "That request never reached the provider, so nothing was done for it. Start it from the beginning.",
    "</previous_request>"
  );

  if (pack.checkpoint) {
    lines.push(`<checkpoint>The user can undo everything this task changed (${pack.checkpoint}).</checkpoint>`);
  }

  lines.push("</handover>", "", "Continue the task now, following the response format described below.");
  return lines.join("\n");
}

/** Short label for the panel / notices. */
export function describeContinuation(pack: ContinuationPackage): string {
  const parts = [`objective: ${firstLine(pack.objective) || "(none)"}`];
  if (pack.changedFiles.length > 0) {
    parts.push(`${pack.changedFiles.length} file${pack.changedFiles.length === 1 ? "" : "s"} already changed`);
  }
  if (pack.toolResults.length > 0) {
    parts.push(`${pack.toolResults.length} tool result${pack.toolResults.length === 1 ? "" : "s"}`);
  }
  return parts.join(" · ");
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max)}\n…[truncated]`;
}

function firstLine(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}
