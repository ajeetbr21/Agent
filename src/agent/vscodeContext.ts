import { execFile } from "child_process";
import { basename } from "path";
import * as vscode from "vscode";
import {
  findSymbolPosition,
  formatDiagnostics,
  formatOpenEditors,
  formatReferences,
  formatSymbols,
  truncateText,
  type DiagnosticEntry,
  type DiagnosticSeverityName,
  type OpenEditorEntry,
  type ReferenceEntry,
  type SymbolEntry
} from "./contextFormat";
import { getWorkspaceRoot, resolveWorkspacePath } from "../workspace/applyAgentChanges";
import { isSecretFile, redactSecrets, secretFileNotice } from "../prompt/redact";

/**
 * Read-only access to what VS Code knows about the project — the Problems panel, open editors,
 * git state, and language-server symbols/references — for agent tools and @-mentions.
 */

const MAX_GIT_OUTPUT_CHARS = 20000;
const MAX_REFERENCE_LINES = 80;

/**
 * Give language servers a chance to re-analyze files the agent just changed, so a `diagnostics` call
 * in the same turn doesn't report a stale "no problems". Opening the documents also makes servers
 * that only analyze open files (TypeScript, ESLint) report on them at all.
 */
export async function refreshDiagnostics(relativePaths: readonly string[], timeoutMs = 4000): Promise<void> {
  const root = getWorkspaceRoot();
  const uris: vscode.Uri[] = [];
  for (const relativePath of relativePaths.slice(0, 20)) {
    try {
      const uri = resolveWorkspacePath(root, relativePath);
      await vscode.workspace.openTextDocument(uri);
      uris.push(uri);
    } catch {
      // deleted or unreadable — nothing to analyze
    }
  }
  if (uris.length === 0) {
    return;
  }

  const wanted = new Set(uris.map((uri) => uri.toString()));
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, timeoutMs);
    const subscription = vscode.languages.onDidChangeDiagnostics((event) => {
      if (event.uris.some((uri) => wanted.has(uri.toString()))) {
        finish();
      }
    });
    function finish() {
      clearTimeout(timer);
      subscription.dispose();
      resolve();
    }
  });
}

export function collectDiagnostics(relativePath?: string): string {
  const root = getWorkspaceRoot();
  // Filter the whole workspace list by prefix, so a FOLDER path works too (getDiagnostics(uri) is
  // per-file and would report "no problems" for a directory).
  const scope = relativePath
    ? vscode.workspace.asRelativePath(resolveWorkspacePath(root, relativePath), false).replace(/\/+$/, "")
    : undefined;
  const pairs = vscode.languages.getDiagnostics();

  const entries: DiagnosticEntry[] = [];
  for (const [uri, diagnostics] of pairs) {
    const path = workspaceRelative(uri);
    if (!path) {
      continue; // outside the workspace (e.g. library typings)
    }
    if (scope && path !== scope && !path.startsWith(`${scope}/`)) {
      continue;
    }
    for (const diagnostic of diagnostics) {
      entries.push({
        path,
        line: diagnostic.range.start.line + 1,
        column: diagnostic.range.start.character + 1,
        severity: severityName(diagnostic.severity),
        message: diagnostic.message,
        source: diagnostic.source,
        code: diagnosticCode(diagnostic.code)
      });
    }
  }
  const text = formatDiagnostics(entries, 150, relativePath);
  return `${text}\n(Only files the language servers have analyzed are covered; run a build/typecheck with \`run\` to be certain.)`;
}

export function collectOpenEditors(): string {
  const active = vscode.window.activeTextEditor;
  const seen = new Set<string>();
  const entries: OpenEditorEntry[] = [];

  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const uri = tabUri(tab);
      if (!uri || uri.scheme !== "file") {
        continue;
      }
      // Files outside the workspace are listed by name only — their absolute path (which can expose
      // the user's directory layout) is not sent to the web chat.
      const path = workspaceRelative(uri) ?? `${basename(uri.fsPath)} (outside this workspace)`;
      if (seen.has(path)) {
        continue;
      }
      seen.add(path);
      const isActive = Boolean(active && active.document.uri.toString() === uri.toString());
      const selection = isActive && active && !active.selection.isEmpty
        ? { startLine: active.selection.start.line + 1, endLine: active.selection.end.line + 1 }
        : undefined;
      entries.push({ path, active: isActive, dirty: tab.isDirty, selection });
    }
  }
  // Active editor first, then the tab order.
  entries.sort((a, b) => Number(b.active) - Number(a.active));
  return formatOpenEditors(entries);
}

/** Workspace-relative paths of open text editors (for the @open mention). */
export function openEditorPaths(): string[] {
  const paths: string[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const uri = tabUri(tab);
      const path = uri && uri.scheme === "file" ? workspaceRelative(uri) : undefined;
      if (path && !paths.includes(path)) {
        paths.push(path);
      }
    }
  }
  return paths;
}

export async function gitStatus(): Promise<string> {
  // "-- ." keeps the report inside the workspace folder even when it sits inside a larger repository.
  const status = await runGit(["status", "--short", "--branch", "--", "."]);
  const recent = await runGit(["log", "--oneline", "-5"]).catch(() => "");
  return truncateText(
    [`git status:\n${status.trim() || "(clean)"}`, recent.trim() ? `Recent commits:\n${recent.trim()}` : ""]
      .filter(Boolean)
      .join("\n\n"),
    MAX_GIT_OUTPUT_CHARS
  );
}

export async function gitDiff(relativePath?: string, staged = false): Promise<string> {
  if (relativePath && isSecretFile(relativePath)) {
    return secretFileNotice(relativePath);
  }
  const pathArgs = ["--", relativePath ? validatedGitPath(relativePath) : "."];
  // --no-ext-diff / --no-textconv: never run a diff helper the repository's config points at.
  const base = ["diff", ...(staged ? ["--staged"] : []), "--no-color", "--no-ext-diff", "--no-textconv"];
  const stat = await runGit([...base, "--stat", ...pathArgs]);
  const diff = await runGit([...base, ...pathArgs]);
  const scope = `${staged ? "staged" : "unstaged"} changes${relativePath ? ` in ${relativePath}` : ""}`;
  if (!diff.trim()) {
    const other = staged ? "" : " (use staged: true for staged changes)";
    return `No ${scope}${other}.`;
  }
  // A committed .env or a staged key would otherwise travel inside the diff body.
  const safeDiff = redactSecrets(diff).text;
  return truncateText(`git diff (${scope}):\n${stat.trim()}\n\n${safeDiff}`, MAX_GIT_OUTPUT_CHARS);
}

export async function findWorkspaceSymbols(query: string): Promise<string> {
  const symbols = (await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
    "vscode.executeWorkspaceSymbolProvider",
    query
  )) ?? [];
  const entries: SymbolEntry[] = [];
  for (const symbol of symbols) {
    const path = workspaceRelative(symbol.location.uri);
    if (!path) {
      continue;
    }
    entries.push({
      name: symbol.name,
      kind: vscode.SymbolKind[symbol.kind] ?? "Symbol",
      path,
      // The workspace-symbol API allows a location without a range (resolved lazily).
      line: (symbol.location.range?.start.line ?? 0) + 1,
      container: symbol.containerName || undefined
    });
  }
  return formatSymbols(query, entries);
}

export async function findReferences(relativePath: string, symbol: string, line?: number): Promise<string> {
  const root = getWorkspaceRoot();
  const uri = resolveWorkspacePath(root, relativePath);
  lineCache.clear(); // files may have changed since the last call
  const document = await vscode.workspace.openTextDocument(uri);
  const found = findSymbolPosition(document.getText(), symbol, line);
  if (!found) {
    return `"${symbol}" does not appear as a whole word in ${relativePath}.`;
  }
  const position = new vscode.Position(found.line, found.character);

  const [definitionResult, referenceResult] = await Promise.all([
    vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[] | vscode.Location | undefined>(
      "vscode.executeDefinitionProvider",
      uri,
      position
    ),
    vscode.commands.executeCommand<vscode.Location[] | undefined>("vscode.executeReferenceProvider", uri, position)
  ]);

  const toEntries = async (items: readonly (vscode.Location | vscode.LocationLink)[]) => {
    const entries: ReferenceEntry[] = [];
    for (const item of items.slice(0, MAX_REFERENCE_LINES)) {
      const target = "targetUri" in item ? item.targetUri : item.uri;
      const range = "targetUri" in item ? item.targetSelectionRange ?? item.targetRange : item.range;
      const path = workspaceRelative(target);
      if (!path || !range) {
        continue;
      }
      entries.push({
        path,
        line: range.start.line + 1,
        column: range.start.character + 1,
        text: await lineText(target, range.start.line)
      });
    }
    return entries;
  };

  const definitions = definitionResult
    ? await toEntries(Array.isArray(definitionResult) ? definitionResult : [definitionResult])
    : [];
  const allReferences = referenceResult ?? [];
  const references = await toEntries(allReferences);
  return formatReferences(symbol, definitions, references, MAX_REFERENCE_LINES, allReferences.length);
}

function workspaceRelative(uri: vscode.Uri): string | undefined {
  if (!vscode.workspace.getWorkspaceFolder(uri)) {
    return undefined;
  }
  return vscode.workspace.asRelativePath(uri, false);
}

function tabUri(tab: vscode.Tab): vscode.Uri | undefined {
  const input = tab.input;
  if (input instanceof vscode.TabInputText) {
    return input.uri;
  }
  if (input instanceof vscode.TabInputTextDiff) {
    return input.modified;
  }
  return undefined;
}

function severityName(severity: vscode.DiagnosticSeverity): DiagnosticSeverityName {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return "error";
    case vscode.DiagnosticSeverity.Warning:
      return "warning";
    case vscode.DiagnosticSeverity.Information:
      return "info";
    default:
      return "hint";
  }
}

function diagnosticCode(code: vscode.Diagnostic["code"]): string | undefined {
  if (code === undefined || code === null) {
    return undefined;
  }
  return typeof code === "object" ? String(code.value) : String(code);
}

const lineCache = new Map<string, string[]>();
async function lineText(uri: vscode.Uri, line: number): Promise<string | undefined> {
  const key = uri.toString();
  const cached = lineCache.get(key);
  if (cached) {
    return cached[line]?.trim();
  }
  let lines: string[];
  try {
    const document = await vscode.workspace.openTextDocument(uri);
    lines = String(document.getText()).split(/\r?\n/);
  } catch {
    return undefined;
  }
  lineCache.set(key, lines);
  if (lineCache.size > 50) {
    lineCache.delete(lineCache.keys().next().value as string);
  }
  return lines[line]?.trim();
}

function validatedGitPath(relativePath: string): string {
  // Reuse the workspace path guard (rejects absolute paths and ../ traversal). Pathspec magic like
  // ":(top)x" or ":/x" would address the whole repository, so it is refused here; --literal-pathspecs
  // below also disarms a leading ":".
  if (relativePath.startsWith(":")) {
    throw new Error(`Refusing git pathspec magic: ${relativePath}`);
  }
  resolveWorkspacePath(getWorkspaceRoot(), relativePath);
  return relativePath.replace(/\\/g, "/");
}

/**
 * Run a read-only git command in the workspace root (no shell, so arguments can't inject).
 * The repository's own config is neutralised: a crafted `.git/config` must not be able to make a
 * "read-only" tool execute a program (fsmonitor, hooks, pager, external diff).
 */
function runGit(args: readonly string[]): Promise<string> {
  if (vscode.workspace.isTrusted === false) {
    // In Restricted Mode the repository is untrusted, and git reads executable settings from it.
    return Promise.reject(new Error("Git tools are disabled in Restricted Mode. Trust this folder to use them."));
  }
  const cwd = getWorkspaceRoot().uri.fsPath;
  const hardened = [
    "--no-pager",
    "--literal-pathspecs",
    "-c", "core.fsmonitor=false",
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.pager=cat",
    "-c", "diff.external=",
    "--no-optional-locks",
    ...args
  ];
  return new Promise((resolve, reject) => {
    execFile("git", hardened, { cwd, timeout: 20_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const detail = `${stderr || ""}`.trim() || error.message;
        reject(new Error(/not a git repository/i.test(detail) ? "This workspace is not a git repository." : `git ${args[0]} failed: ${detail}`));
        return;
      }
      resolve(String(stdout));
    });
  });
}
