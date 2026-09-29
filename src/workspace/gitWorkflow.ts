import { isGitRepository, runGit } from "./gitCli";
import { parseStatus, parseTaskCommits, type WorkingTreeStatus } from "./gitNaming";

export { parseStatus, parseTaskCommits, toBranchName, toCommitMessage, type WorkingTreeStatus } from "./gitNaming";

/**
 * Optional git safety net for agent work: put each task on its own branch and commit every applied
 * turn, so nothing the agent does can be lost and the whole task can be reverted later — unlike the
 * in-memory undo stack, which disappears when the window closes.
 *
 * Deliberately conservative: it never touches the user's existing work. If the working tree is dirty
 * the caller decides what to do, and only files the agent actually changed are ever staged.
 *
 * The pure helpers at the top are unit-tested; the operations below need a real repository.
 */

// ---- operations ----------------------------------------------------------------------------------

export interface GitWorkflowState {
  readonly taskId: string;
  readonly branch: string;
  /** Branch the user was on when the task started, so we can offer to go back. */
  readonly startedFrom?: string;
  commits: number;
}

export async function available(): Promise<boolean> {
  return isGitRepository();
}

export async function status(): Promise<WorkingTreeStatus> {
  const result = await runGit(["status", "--porcelain=v1", "--branch", "--", "."]);
  return parseStatus(result.stdout);
}

export async function currentBranch(): Promise<string | undefined> {
  const result = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], { allowFailure: true });
  const name = result.stdout.trim();
  return result.exitCode === 0 && name && name !== "HEAD" ? name : undefined;
}

/** True when the repository has at least one commit (a fresh `git init` has none). */
export async function hasCommits(): Promise<boolean> {
  const result = await runGit(["rev-parse", "--verify", "HEAD"], { allowFailure: true });
  return result.exitCode === 0;
}

/**
 * Create and switch to the task branch. A name that already exists gets a numeric suffix, so an
 * earlier task's branch is never reused or rewritten.
 */
export async function createTaskBranch(desired: string): Promise<string> {
  let name = desired;
  for (let attempt = 2; attempt <= 50; attempt += 1) {
    const exists = await runGit(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], { allowFailure: true });
    if (exists.exitCode !== 0) {
      break;
    }
    name = `${desired}-${attempt}`;
  }
  await runGit(["checkout", "-b", name]);
  return name;
}

export async function checkoutBranch(name: string): Promise<void> {
  await runGit(["checkout", name]);
}

/**
 * Stage exactly the paths the agent changed and commit them. Returns the new commit's short hash, or
 * undefined when those paths turned out to have nothing to commit (e.g. an edit that changed nothing,
 * or a file matched by .gitignore).
 */
export async function commitPaths(
  paths: readonly string[],
  message: string
): Promise<{ hash: string; committed: readonly string[] } | undefined> {
  if (paths.length === 0) {
    return undefined;
  }
  // -- separates paths from options; --ignore-unmatch style safety comes from allowFailure.
  await runGit(["add", "--", ...paths], { allowFailure: true });

  const staged = await runGit(["diff", "--cached", "--name-only", "--", ...paths], { allowFailure: true });
  const committed = staged.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  if (committed.length === 0) {
    return undefined;
  }

  // Only the agent's paths are committed, so a commit never picks up the user's unrelated work.
  await runGit(["commit", "--no-verify", "--only", "-m", message, "--", ...paths]);
  const head = await runGit(["rev-parse", "--short", "HEAD"]);
  return { hash: head.stdout.trim(), committed };
}

/** Commits created for a task, newest first. */
export async function taskCommits(taskId: string): Promise<{ hash: string; subject: string }[]> {
  const result = await runGit(
    ["log", "--format=%h %s", `--grep=LeechCode-Task: ${taskId}`, "--fixed-strings", "-50"],
    { allowFailure: true }
  );
  return result.exitCode === 0 ? parseTaskCommits(result.stdout) : [];
}

/**
 * Undo a task by reverting its commits (oldest-last order), keeping history intact. Reverting is
 * preferred over reset because it cannot lose work that came after.
 */
export async function revertCommits(hashes: readonly string[]): Promise<{ reverted: string[]; conflict?: string }> {
  const reverted: string[] = [];
  for (const hash of hashes) {
    const result = await runGit(["revert", "--no-edit", "--no-commit", hash], { allowFailure: true });
    if (result.exitCode !== 0) {
      await runGit(["revert", "--quit"], { allowFailure: true });
      await runGit(["reset", "--", "."], { allowFailure: true });
      return { reverted, conflict: result.stderr.trim() || `could not revert ${hash}` };
    }
    reverted.push(hash);
  }
  if (reverted.length > 0) {
    await runGit(["commit", "--no-verify", "-m", `Revert LeechCode task changes\n\nReverted: ${reverted.join(", ")}`]);
  }
  return { reverted };
}

/** Unified diff of everything committed for a task, for handing to a reviewer. */
export async function taskDiff(taskId: string, maxChars: number): Promise<string> {
  const commits = await taskCommits(taskId);
  if (commits.length === 0) {
    // Nothing committed (git workflow off, or commits disabled) — fall back to the working tree.
    const result = await runGit(["diff", "--no-ext-diff", "--no-textconv", "HEAD", "--", "."], { allowFailure: true });
    return truncateDiff(result.stdout, maxChars);
  }
  const oldest = commits[commits.length - 1].hash;
  const result = await runGit(
    ["diff", "--no-ext-diff", "--no-textconv", `${oldest}^`, "HEAD", "--", "."],
    { allowFailure: true }
  );
  return truncateDiff(result.stdout, maxChars);
}

function truncateDiff(diff: string, maxChars: number): string {
  const trimmed = diff.trim();
  return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, maxChars)}\n…[diff truncated]`;
}
