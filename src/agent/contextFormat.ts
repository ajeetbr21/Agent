/**
 * Text formatting for the VS Code context tools (diagnostics, open editors, symbols, references).
 * Pure (no vscode import) so it is unit-testable; vscodeContext.ts gathers the data.
 */

export type DiagnosticSeverityName = "error" | "warning" | "info" | "hint";

export interface DiagnosticEntry {
  readonly path: string;
  /** 1-based. */
  readonly line: number;
  /** 1-based. */
  readonly column: number;
  readonly severity: DiagnosticSeverityName;
  readonly message: string;
  readonly source?: string;
  readonly code?: string;
}

export interface OpenEditorEntry {
  readonly path: string;
  readonly active: boolean;
  readonly dirty: boolean;
  /** 1-based inclusive line range of the active editor's selection (only when non-empty). */
  readonly selection?: { readonly startLine: number; readonly endLine: number };
}

export interface SymbolEntry {
  readonly name: string;
  readonly kind: string;
  readonly path: string;
  /** 1-based. */
  readonly line: number;
  readonly container?: string;
}

export interface ReferenceEntry {
  readonly path: string;
  /** 1-based. */
  readonly line: number;
  /** 1-based. */
  readonly column: number;
  readonly text?: string;
}

const SEVERITY_ORDER: Record<DiagnosticSeverityName, number> = { error: 0, warning: 1, info: 2, hint: 3 };

export function formatDiagnostics(entries: readonly DiagnosticEntry[], max = 150, scope?: string): string {
  const where = scope ? ` in ${scope}` : " in the workspace";
  if (entries.length === 0) {
    return `No problems${where} (VS Code's Problems panel is empty${scope ? " for this file" : ""}).`;
  }

  const sorted = [...entries].sort((a, b) =>
    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
    a.path.localeCompare(b.path) ||
    a.line - b.line ||
    a.column - b.column
  );
  const counts = countBy(sorted.map((entry) => entry.severity));
  const header = `Problems${where}: ${(["error", "warning", "info", "hint"] as const)
    .filter((severity) => counts[severity])
    .map((severity) => `${counts[severity]} ${severity}${counts[severity] === 1 ? "" : "s"}`)
    .join(", ")}`;

  const lines = sorted.slice(0, max).map((entry) => {
    const origin = [entry.source, entry.code].filter(Boolean).join(" ");
    return `${entry.path}:${entry.line}:${entry.column} ${entry.severity}: ${oneLine(entry.message)}${origin ? ` [${origin}]` : ""}`;
  });
  const more = sorted.length > max ? `\n…[${sorted.length - max} more]` : "";
  return `${header}\n${lines.join("\n")}${more}`;
}

export function formatOpenEditors(entries: readonly OpenEditorEntry[]): string {
  if (entries.length === 0) {
    return "No files are open in the editor.";
  }
  const lines = entries.map((entry) => {
    const flags = [
      entry.active ? "active" : "",
      entry.dirty ? "unsaved changes" : "",
      entry.selection ? `selection lines ${entry.selection.startLine}-${entry.selection.endLine}` : ""
    ].filter(Boolean);
    return `${entry.path}${flags.length ? `  (${flags.join(", ")})` : ""}`;
  });
  return `Open editors (${entries.length}):\n${lines.join("\n")}`;
}

export function formatSymbols(query: string, entries: readonly SymbolEntry[], max = 60): string {
  if (entries.length === 0) {
    return `No symbols matching "${query}". (Workspace symbol search needs the language's VS Code extension; it may also still be loading — try search instead.)`;
  }
  const lines = entries.slice(0, max).map((entry) =>
    `${entry.kind} ${entry.name}${entry.container ? ` (in ${entry.container})` : ""} — ${entry.path}:${entry.line}`
  );
  const more = entries.length > max ? `\n…[${entries.length - max} more]` : "";
  return `Symbols matching "${query}" (${entries.length}):\n${lines.join("\n")}${more}`;
}

export function formatReferences(
  symbol: string,
  definitions: readonly ReferenceEntry[],
  references: readonly ReferenceEntry[],
  max = 80,
  /** Total found before capping, so the caller can report "N more". */
  totalReferences = references.length
): string {
  const describe = (entry: ReferenceEntry) =>
    `${entry.path}:${entry.line}:${entry.column}${entry.text ? `  ${oneLine(entry.text).slice(0, 160)}` : ""}`;
  const parts = [
    definitions.length > 0
      ? `Definition${definitions.length === 1 ? "" : "s"} of ${symbol}:\n${definitions.map(describe).join("\n")}`
      : `No definition found for ${symbol}.`,
    references.length > 0
      ? `References to ${symbol} (${totalReferences}):\n${references.slice(0, max).map(describe).join("\n")}${totalReferences > references.length ? `\n…[${totalReferences - references.length} more]` : ""}`
      : `No references found for ${symbol} (the language's VS Code extension may be missing or still loading — try search instead).`
  ];
  return parts.join("\n\n");
}

/**
 * Where does `symbol` occur in `text` as a whole word? Prefers an occurrence on `preferLine`
 * (1-based) — or the nearest one to it. Returns a 0-based position for the VS Code API.
 */
export function findSymbolPosition(
  text: string,
  symbol: string,
  preferLine?: number
): { line: number; character: number } | undefined {
  const name = symbol.trim();
  if (!name) {
    return undefined;
  }
  const pattern = new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`, "g");
  const lines = text.split(/\r?\n/);
  let best: { line: number; character: number; distance: number } | undefined;

  for (let line = 0; line < lines.length; line += 1) {
    pattern.lastIndex = 0;
    const match = pattern.exec(lines[line]);
    if (!match) {
      continue;
    }
    const distance = preferLine ? Math.abs(line + 1 - preferLine) : line;
    if (!best || distance < best.distance) {
      best = { line, character: match.index, distance };
      if (distance === 0) {
        break;
      }
    }
  }
  return best ? { line: best.line, character: best.character } : undefined;
}

export function truncateText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}

function oneLine(text: string): string {
  return text.replace(/\s*\r?\n\s*/g, " ").trim();
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
