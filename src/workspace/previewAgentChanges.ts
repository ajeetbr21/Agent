import * as path from "path";
import * as vscode from "vscode";
import type { AgentFileChange } from "../agent/toolProtocol";
import { AgentChangeError, planAgentFileChanges, type AppliedAgentChange } from "./applyAgentChanges";

const MAX_DIFF_PREVIEWS = 8;

/**
 * Open before→after diffs for changes that were just APPLIED (using the pre-edit snapshots), so the
 * developer sees exactly what each edit did — the workspace file already holds the new content.
 */
export async function openAppliedDiffs(
  applied: readonly AppliedAgentChange[],
  context: vscode.ExtensionContext,
  filterPath?: string
): Promise<number> {
  const emptyRoot = vscode.Uri.joinPath(context.globalStorageUri, "applied-empty");
  await vscode.workspace.fs.createDirectory(emptyRoot);
  let opened = 0;

  for (const change of applied) {
    if (filterPath && change.path !== filterPath) {
      continue;
    }
    if (opened >= MAX_DIFF_PREVIEWS) {
      break;
    }
    if (change.action === "delete") {
      const empty = vscode.Uri.joinPath(emptyRoot, ...splitPath(change.path));
      await ensureParentDirectory(empty);
      await vscode.workspace.fs.writeFile(empty, new Uint8Array());
      await vscode.commands.executeCommand(
        "vscode.diff",
        change.originalUri,
        empty,
        `WebChat applied (deleted): ${change.path}`
      );
      opened += 1;
      continue;
    }
    if (change.currentUri) {
      await vscode.commands.executeCommand(
        "vscode.diff",
        change.originalUri,
        change.currentUri,
        `WebChat applied${change.existedBefore ? "" : " (new)"}: ${change.path}`
      );
      opened += 1;
    }
  }

  return opened;
}

/**
 * Pre-apply preview: current file on disk vs what applying the whole response would produce. Uses
 * the same planner as apply, so several edits to one file stack into a single diff and the preview
 * can never disagree with what Apply would write.
 */
export async function previewAgentFileChanges(
  changes: readonly AgentFileChange[],
  context: vscode.ExtensionContext,
  filterPath?: string
): Promise<number> {
  const previewRoot = vscode.Uri.joinPath(context.globalStorageUri, "previews", String(Date.now()));
  const emptyRoot = vscode.Uri.joinPath(previewRoot, "__empty__");
  await vscode.workspace.fs.createDirectory(previewRoot);

  let planned;
  try {
    planned = await planAgentFileChanges(changes);
  } catch (error) {
    // Show why the response can't be applied instead of opening misleading diffs.
    const problems = error instanceof AgentChangeError ? error.problems : [error instanceof Error ? error.message : String(error)];
    const note = vscode.Uri.joinPath(previewRoot, "CANNOT_APPLY.txt");
    await ensureParentDirectory(note);
    await vscode.workspace.fs.writeFile(
      note,
      Buffer.from(["These changes cannot be applied as-is:", ...problems.map((problem) => `- ${problem}`)].join("\n"), "utf8")
    );
    await vscode.window.showTextDocument(note, { preview: true });
    return 0;
  }

  // One diff per file: the last planned entry holds the fully stacked result.
  const finalByFile = new Map<string, (typeof planned)[number]>();
  for (const item of planned) {
    finalByFile.set(item.key, item);
  }

  let opened = 0;
  for (const item of finalByFile.values()) {
    if (filterPath && item.change.path !== filterPath) {
      continue;
    }
    if (opened >= MAX_DIFF_PREVIEWS) {
      break;
    }
    const relative = splitPath(item.change.path);
    const preview = vscode.Uri.joinPath(previewRoot, ...relative);
    const empty = vscode.Uri.joinPath(emptyRoot, ...relative);
    await ensureParentDirectory(preview);
    await ensureParentDirectory(empty);
    await vscode.workspace.fs.writeFile(empty, new Uint8Array());
    await vscode.workspace.fs.writeFile(preview, item.next ?? new Uint8Array());

    const left = item.existedBefore ? item.target : empty;
    const right = item.next ? preview : empty;
    const label = item.next
      ? `WebChat ${item.existedBefore ? "change" : "new file"} preview: ${item.change.path}`
      : `WebChat delete preview: ${item.change.path}`;
    await vscode.commands.executeCommand("vscode.diff", left, right, label);
    opened += 1;
  }

  return opened;
}

function splitPath(relativePath: string): string[] {
  return path.normalize(relativePath).replaceAll("\\", "/").split("/").filter(Boolean);
}

async function ensureParentDirectory(target: vscode.Uri): Promise<void> {
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(target.fsPath)));
}
