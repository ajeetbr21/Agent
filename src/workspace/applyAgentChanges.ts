import { createHash } from "crypto";
import * as path from "path";
import * as vscode from "vscode";
import { applyTextEdits } from "../agent/fileEdits";
import type { AgentFileChange } from "../agent/toolProtocol";

export interface AppliedAgentChange {
  readonly path: string;
  readonly action: AgentFileChange["action"];
  /** Resolved target URI string — identifies the file regardless of how the model spelled the path. */
  readonly key: string;
  /** Snapshot of the file's content BEFORE the edit (an empty file if it did not exist). */
  readonly originalUri: vscode.Uri;
  /** The workspace file after the edit — the diff's right-hand side. Undefined for deletes. */
  readonly currentUri?: vscode.Uri;
  readonly existedBefore: boolean;
  /** sha256 of what the agent wrote (undefined for deletes) — lets undo detect later user edits. */
  readonly afterHash?: string;
}

/** Thrown when any change in a response can't be applied; nothing from that response is written. */
export class AgentChangeError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(problems.join("\n"));
    this.name = "AgentChangeError";
  }
}

export interface PlannedChange {
  readonly change: AgentFileChange;
  readonly target: vscode.Uri;
  /** Resolved target URI string, used to key per-file bookkeeping. */
  readonly key: string;
  readonly existedBefore: boolean;
  readonly original: Uint8Array;
  /** New bytes to write; undefined for deletes. */
  readonly next?: Uint8Array;
}

/**
 * Resolve a response's changes into the exact bytes to write per file, validating every targeted
 * edit first. Several entries may target one file — they are planned on top of each other, so a
 * later edit sees the earlier one's result. Throws AgentChangeError if ANY change is invalid, so
 * callers (apply and preview) agree and a bad response writes nothing.
 */
export async function planAgentFileChanges(changes: readonly AgentFileChange[]): Promise<PlannedChange[]> {
  const root = getWorkspaceRoot();
  const planned: PlannedChange[] = [];
  const problems: string[] = [];
  // Several changes may target the same file (e.g. two edit entries); plan them on top of each other.
  const pending = new Map<string, { bytes: Uint8Array; exists: boolean }>();

  for (const change of changes) {
    let target: vscode.Uri;
    try {
      assertWritableWorkspacePath(change.path);
      target = resolveWorkspacePath(root, change.path);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    const key = target.toString();

    let existedBefore = true;
    let original: Uint8Array = new Uint8Array();
    try {
      original = await vscode.workspace.fs.readFile(target);
    } catch {
      existedBefore = false;
    }
    const current = pending.get(key) ?? { bytes: original, exists: existedBefore };

    if (change.action === "delete") {
      planned.push({ change, target, key, existedBefore, original });
      pending.set(key, { bytes: new Uint8Array(), exists: false });
      continue;
    }

    if (change.action === "edit") {
      if (!current.exists) {
        problems.push(`${change.path}: cannot edit a file that does not exist — use a write action to create it.`);
        continue;
      }
      let currentText: string;
      try {
        // An edit only rewrites part of the file, so the rest must survive byte-for-byte. Refuse
        // rather than replacing every non-UTF-8 byte with U+FFFD.
        currentText = new TextDecoder("utf-8", { fatal: true }).decode(current.bytes);
      } catch {
        problems.push(`${change.path}: is not valid UTF-8, so it cannot be edited by find/replace. Use a write action with the full new content.`);
        continue;
      }
      const result = applyTextEdits(currentText, change.edits ?? []);
      if (!result.ok) {
        problems.push(`${change.path}: ${result.error}`);
        continue;
      }
      const next = Buffer.from(result.content, "utf8");
      planned.push({ change, target, key, existedBefore, original, next });
      pending.set(key, { bytes: next, exists: true });
      continue;
    }

    const next = Buffer.from(change.content || "", "utf8");
    planned.push({ change, target, key, existedBefore, original, next });
    pending.set(key, { bytes: next, exists: true });
  }

  if (problems.length > 0) {
    throw new AgentChangeError(problems);
  }

  return planned;
}

/**
 * Apply the model's file changes, snapshotting each file's pre-edit content first so a real
 * before→after diff can be shown after the edit is made (the working file already holds the new
 * content, so a diff against disk would otherwise be empty).
 *
 * All changes are planned (and every targeted edit validated) before anything is written, so a
 * response with one bad edit leaves the workspace untouched.
 */
export async function applyAgentFileChanges(
  changes: readonly AgentFileChange[],
  context: vscode.ExtensionContext
): Promise<readonly AppliedAgentChange[]> {
  const planned = await planAgentFileChanges(changes);
  const snapshotRoot = vscode.Uri.joinPath(context.globalStorageUri, "applied", String(Date.now()), "before");
  const applied: AppliedAgentChange[] = [];
  const snapshotted = new Set<string>();
  // Writing is not atomic (a locked file, EACCES, a parent path that is a file). Remember what has
  // been written so a failure half-way can be rolled back instead of leaving a partial apply that
  // the model is told never happened.
  const written: PlannedChange[] = [];

  try {
    for (const item of planned) {
      const { change, target, key } = item;
      // The "before" of a file is its content before THIS response touched it, even if two entries
      // in the response edit it.
      const originalUri = vscode.Uri.joinPath(snapshotRoot, ...splitPath(change.path));
      if (!snapshotted.has(key)) {
        await ensureParentDirectory(originalUri);
        await vscode.workspace.fs.writeFile(originalUri, item.original);
        snapshotted.add(key);
      }

      if (!item.next) {
        if (item.existedBefore) {
          try {
            await vscode.workspace.fs.delete(target, { recursive: false, useTrash: false });
          } catch (error) {
            if (await exists(target)) {
              throw error; // a real failure (locked / permission), not "already gone"
            }
          }
          written.push(item);
        }
        applied.push({
          path: change.path,
          action: change.action,
          key,
          originalUri,
          existedBefore: item.existedBefore
        });
        continue;
      }

      await ensureParentDirectory(target);
      await vscode.workspace.fs.writeFile(target, item.next);
      written.push(item);
      applied.push({
        path: change.path,
        action: change.action,
        key,
        originalUri,
        currentUri: target,
        existedBefore: item.existedBefore,
        afterHash: hashBytes(item.next)
      });
    }

    return mergeAppliedByFile(applied);
  } catch (error) {
    await rollbackWrites(written);
    const message = error instanceof Error ? error.message : String(error);
    throw new AgentChangeError([`could not write the changes (${message}); the workspace was restored to its previous state`]);
  }
}

/** Put back the files written before a mid-apply failure, newest first. */
async function rollbackWrites(written: readonly PlannedChange[]): Promise<void> {
  for (const item of [...written].reverse()) {
    try {
      if (item.existedBefore) {
        await ensureParentDirectory(item.target);
        await vscode.workspace.fs.writeFile(item.target, item.original);
      } else {
        await vscode.workspace.fs.delete(item.target, { recursive: false, useTrash: false });
      }
    } catch {
      // Best effort: keep restoring the rest.
    }
  }
}

/**
 * Files whose current content is no longer what the agent left there (the user edited them since,
 * or recreated a file the agent deleted). Undoing those would overwrite the user's work.
 */
export async function detectRevertConflicts(changes: readonly AppliedAgentChange[]): Promise<string[]> {
  const root = getWorkspaceRoot();
  const conflicts: string[] = [];
  for (const change of changes) {
    const current = await readIfExists(resolveWorkspacePath(root, change.path));
    const untouched = change.afterHash === undefined
      ? current === undefined // the agent deleted it and it is still gone
      : current !== undefined && hashBytes(current) === change.afterHash;
    if (!untouched) {
      conflicts.push(change.path);
    }
  }
  return conflicts;
}

/**
 * Undo applied changes using their pre-edit snapshots: restore the old content, or delete a file the
 * agent created. Check detectRevertConflicts first — this overwrites unconditionally.
 */
export async function revertAgentFileChanges(changes: readonly AppliedAgentChange[]): Promise<string[]> {
  const root = getWorkspaceRoot();
  const reverted: string[] = [];

  for (const change of changes) {
    const target = resolveWorkspacePath(root, change.path);
    if (change.existedBefore) {
      const original = await vscode.workspace.fs.readFile(change.originalUri);
      await ensureParentDirectory(target);
      await vscode.workspace.fs.writeFile(target, original);
    } else if ((await readIfExists(target)) !== undefined) {
      await vscode.workspace.fs.delete(target, { recursive: false, useTrash: false });
    }
    reverted.push(change.path);
  }

  return reverted;
}

async function readIfExists(target: vscode.Uri): Promise<Uint8Array | undefined> {
  try {
    return await vscode.workspace.fs.readFile(target);
  } catch {
    return undefined;
  }
}

export function getWorkspaceRoot(): vscode.WorkspaceFolder {
  const root = vscode.workspace.workspaceFolders?.[0];

  if (!root) {
    throw new Error("Open a workspace folder before applying WebChat file changes.");
  }

  return root;
}

export function resolveWorkspacePath(root: vscode.WorkspaceFolder, relativePath: string): vscode.Uri {
  const normalized = path.normalize(relativePath).replaceAll("\\", "/");

  if (
    path.isAbsolute(relativePath) ||
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized === ".." ||
    normalized.includes("/../")
  ) {
    throw new Error(`Refusing unsafe workspace path: ${relativePath}`);
  }

  return vscode.Uri.joinPath(root.uri, ...normalized.split("/").filter(Boolean));
}

/**
 * Paths the agent must never write: `.git` holds the repository's history AND its configuration.
 * A written `.git/config` (fsmonitor, diff.external, clean/textconv filters) or `.git/hooks/*` turns
 * a later "read-only" git command — or the user's next commit — into arbitrary code execution, which
 * would side-step the command approval entirely.
 */
export function assertWritableWorkspacePath(relativePath: string): void {
  const normalized = path.normalize(relativePath).replaceAll("\\", "/").toLowerCase();
  const segments = normalized.split("/").filter(Boolean);
  if (segments.includes(".git")) {
    throw new Error(`Refusing to modify repository internals: ${relativePath}`);
  }
}

/**
 * One entry per file: the first snapshot (true "before"), the last write (true "after"). Keyed by
 * resolved URI, so "src/a.ts" and "./src/a.ts" in one response are recognised as the same file.
 */
function mergeAppliedByFile(applied: readonly AppliedAgentChange[]): AppliedAgentChange[] {
  const byFile = new Map<string, AppliedAgentChange>();
  for (const change of applied) {
    const first = byFile.get(change.key);
    byFile.set(change.key, first
      ? { ...change, path: first.path, originalUri: first.originalUri, existedBefore: first.existedBefore }
      : change);
  }
  return [...byFile.values()];
}

async function exists(target: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function splitPath(relativePath: string): string[] {
  return path.normalize(relativePath).replaceAll("\\", "/").split("/").filter(Boolean);
}

async function ensureParentDirectory(target: vscode.Uri): Promise<void> {
  const parentPath = path.dirname(target.fsPath);
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(parentPath));
}
