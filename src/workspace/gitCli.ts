import { execFile } from "child_process";
import * as vscode from "vscode";
import { getWorkspaceRoot } from "./applyAgentChanges";

/**
 * One place that runs `git`, so every call gets the same hardening.
 *
 * A repository carries executable configuration (`core.fsmonitor`, hooks, external diff/textconv,
 * pagers). Since the agent can write files in the workspace, those must never be honoured by a
 * command LeechCode runs on its own — otherwise a "read-only" git call becomes arbitrary code
 * execution. Arguments are passed as an argv array (no shell), so nothing can be injected either.
 */

const HARDENING = [
  "--no-pager",
  "--literal-pathspecs",
  "-c", "core.fsmonitor=false",
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.pager=cat",
  "-c", "diff.external=",
  "--no-optional-locks"
];

export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** Run git in the workspace root. Rejects on a non-zero exit unless `allowFailure` is set. */
export async function runGit(
  args: readonly string[],
  options: { allowFailure?: boolean; timeoutMs?: number } = {}
): Promise<GitResult> {
  if (vscode.workspace.isTrusted === false) {
    // Restricted Mode: the repository is untrusted and git reads settings from it.
    throw new Error("Git is disabled in Restricted Mode. Trust this folder to use git features.");
  }
  const cwd = getWorkspaceRoot().uri.fsPath;

  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...HARDENING, ...args],
      { cwd, timeout: options.timeoutMs ?? 20_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const result: GitResult = {
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          exitCode: typeof (error as { code?: unknown })?.code === "number" ? (error as { code: number }).code : error ? 1 : 0
        };
        if (error && !options.allowFailure) {
          const detail = result.stderr.trim() || (error instanceof Error ? error.message : String(error));
          reject(new Error(/not a git repository/i.test(detail) ? "This workspace is not a git repository." : detail));
          return;
        }
        resolve(result);
      }
    );
  });
}

/** True when the workspace root is inside a git work tree. */
export async function isGitRepository(): Promise<boolean> {
  try {
    const result = await runGit(["rev-parse", "--is-inside-work-tree"], { allowFailure: true });
    return result.exitCode === 0 && result.stdout.trim() === "true";
  } catch {
    return false;
  }
}
