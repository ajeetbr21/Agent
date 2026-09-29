/**
 * Naming and output parsing for the git safety net. Kept free of any `vscode` import so it can be
 * unit-tested directly; the operations that need a real repository live in gitWorkflow.ts.
 */

const MAX_BRANCH_SLUG = 40;
const MAX_SUBJECT = 72;

/** Turn a task objective into a readable, valid branch name (`leechcode/add-login-form`). */
export function toBranchName(objective: string, prefix = "leechcode"): string {
  const slug = objective
    .toLowerCase()
    .replace(/[`'"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_BRANCH_SLUG)
    .replace(/-+$/, "");
  const cleanPrefix = prefix.replace(/[^a-zA-Z0-9/_-]+/g, "").replace(/^\/+|\/+$/g, "") || "leechcode";
  return `${cleanPrefix}/${slug || "task"}`;
}

/**
 * Commit message from the model's summary: a short subject plus the file list. The trailer marks
 * commits LeechCode created, which is how "revert this task" finds them again.
 */
export function toCommitMessage(
  summary: string,
  files: readonly { readonly path: string; readonly action: string }[],
  taskId: string
): string {
  const firstLine = summary.trim().split("\n").find((line) => line.trim().length > 0) ?? "";
  const subject = firstLine
    .replace(/^[-*\s]+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SUBJECT) || "LeechCode agent changes";
  const body = files.map((file) => `- ${file.action}: ${file.path}`).join("\n");
  return [subject, "", body, "", `LeechCode-Task: ${taskId}`].filter((part) => part !== undefined).join("\n");
}

export interface WorkingTreeStatus {
  readonly branch?: string;
  /** Paths with uncommitted changes (staged or not), excluding untracked files. */
  readonly changed: readonly string[];
  readonly untracked: readonly string[];
  readonly clean: boolean;
}

/** Parse `git status --porcelain=v1 --branch` output. */
export function parseStatus(stdout: string): WorkingTreeStatus {
  const changed: string[] = [];
  const untracked: string[] = [];
  let branch: string | undefined;

  for (const line of stdout.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    if (line.startsWith("##")) {
      // "## main...origin/main [ahead 1]" or "## HEAD (no branch)"
      const name = line.slice(2).trim().split(/\.{3}|\s+/)[0];
      branch = name && name !== "HEAD" ? name : undefined;
      continue;
    }
    const code = line.slice(0, 2);
    const path = line.slice(3).trim();
    if (!path) {
      continue;
    }
    if (code === "??") {
      untracked.push(path);
    } else {
      // Renames are reported as "old -> new"; keep the new path.
      changed.push(path.includes(" -> ") ? path.split(" -> ")[1] : path);
    }
  }

  return { branch, changed, untracked, clean: changed.length === 0 };
}

/** Commit subjects/hashes belonging to one task, newest first. */
export function parseTaskCommits(stdout: string): { hash: string; subject: string }[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [hash, ...rest] = line.split(" ");
      return { hash, subject: rest.join(" ") };
    })
    .filter((commit) => /^[0-9a-f]{7,40}$/i.test(commit.hash));
}
