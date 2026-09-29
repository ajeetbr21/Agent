import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { installFakeVscode } from "./helpers/fakeVscode";

// The git safety net runs real git commands, so it is exercised against a real throwaway repository.
const fake = installFakeVscode();
// eslint-disable-next-line @typescript-eslint/no-require-imports
const git = require("../workspace/gitWorkflow") as typeof import("../workspace/gitWorkflow");

function run(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null"
    }
  });
}

async function repo(files: Record<string, string> = { "README.md": "# Demo\n" }): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lc-git-"));
  run(root, "init", "--initial-branch=main", ".");
  run(root, "config", "user.name", "Test");
  run(root, "config", "user.email", "test@example.com");
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), content);
  }
  run(root, "add", "-A");
  run(root, "commit", "-m", "initial");
  fake.setRoot(root);
  return root;
}

test("a task gets its own branch, and existing branches are never reused", async () => {
  const root = await repo();
  assert.equal(await git.available(), true);
  assert.equal(await git.hasCommits(), true);
  assert.equal(await git.currentBranch(), "main");

  const first = await git.createTaskBranch(git.toBranchName("Add a login form"));
  assert.equal(first, "leechcode/add-a-login-form");
  assert.equal(await git.currentBranch(), first);

  await git.checkoutBranch("main");
  const second = await git.createTaskBranch(git.toBranchName("Add a login form"));
  assert.equal(second, "leechcode/add-a-login-form-2", "a second task with the same name gets a suffix");
  void root;
});

test("only the agent's files are committed, never the user's other work", async () => {
  const root = await repo({ "README.md": "# Demo\n", "src/app.ts": "export const a = 1;\n", "src/mine.ts": "// my work\n" });
  await git.createTaskBranch("leechcode/task");

  // The user is editing one file while the agent changes another.
  await fs.writeFile(path.join(root, "src/mine.ts"), "// my work in progress\n");
  await fs.writeFile(path.join(root, "src/app.ts"), "export const a = 2;\n");
  await fs.writeFile(path.join(root, "src/new.ts"), "export const b = 3;\n");

  const result = await git.commitPaths(
    ["src/app.ts", "src/new.ts"],
    git.toCommitMessage("Bump a and add b", [{ path: "src/app.ts", action: "edit" }, { path: "src/new.ts", action: "write" }], "task-1")
  );

  assert.ok(result, "a commit was created");
  assert.deepEqual([...(result?.committed ?? [])].sort(), ["src/app.ts", "src/new.ts"]);

  const committed = run(root, "show", "--name-only", "--format=", "HEAD").trim().split("\n").sort();
  assert.deepEqual(committed, ["src/app.ts", "src/new.ts"]);

  // The user's in-progress file is still uncommitted.
  const status = await git.status();
  assert.deepEqual(status.changed, ["src/mine.ts"]);
  assert.match(run(root, "log", "-1", "--format=%B"), /LeechCode-Task: task-1/);
});

test("commitPaths reports nothing when the paths have no changes", async () => {
  const root = await repo({ "src/app.ts": "same\n" });
  await git.createTaskBranch("leechcode/task");
  assert.equal(await git.commitPaths(["src/app.ts"], "no-op"), undefined);
  assert.equal(await git.commitPaths([], "empty"), undefined);
  void root;
});

test("a task's commits are found and can be reverted without losing later work", async () => {
  const root = await repo({ "src/app.ts": "v1\n" });
  await git.createTaskBranch("leechcode/task");

  await fs.writeFile(path.join(root, "src/app.ts"), "v2 by agent\n");
  await git.commitPaths(["src/app.ts"], git.toCommitMessage("Step one", [{ path: "src/app.ts", action: "edit" }], "task-7"));
  await fs.writeFile(path.join(root, "src/extra.ts"), "added by agent\n");
  await git.commitPaths(["src/extra.ts"], git.toCommitMessage("Step two", [{ path: "src/extra.ts", action: "write" }], "task-7"));

  // An unrelated commit from the user, which must survive the revert.
  await fs.writeFile(path.join(root, "notes.md"), "my notes\n");
  run(root, "add", "notes.md");
  run(root, "commit", "-m", "my own commit");

  const commits = await git.taskCommits("task-7");
  assert.equal(commits.length, 2, "both task commits are found");
  assert.deepEqual(commits.map((commit) => commit.subject), ["Step two", "Step one"]);

  const other = await git.taskCommits("task-other");
  assert.equal(other.length, 0, "another task's id matches nothing");

  const result = await git.revertCommits(commits.map((commit) => commit.hash));
  assert.equal(result.conflict, undefined);
  assert.equal(result.reverted.length, 2);

  assert.equal(await fs.readFile(path.join(root, "src/app.ts"), "utf8"), "v1\n", "the agent's edit is undone");
  assert.equal(await fs.access(path.join(root, "src/extra.ts")).then(() => true, () => false), false, "the agent's new file is gone");
  assert.equal(await fs.readFile(path.join(root, "notes.md"), "utf8"), "my notes\n", "the user's own commit survives");
  assert.equal((await git.status()).clean, true, "the revert is committed, not left staged");
});

test("taskDiff produces a real diff of the task's commits", async () => {
  const root = await repo({ "src/app.ts": "const retries = 3;\n" });
  await git.createTaskBranch("leechcode/task");
  await fs.writeFile(path.join(root, "src/app.ts"), "const retries = 5;\n");
  await git.commitPaths(["src/app.ts"], git.toCommitMessage("Raise retries", [{ path: "src/app.ts", action: "edit" }], "task-9"));

  const diff = await git.taskDiff("task-9", 10000);
  assert.match(diff, /diff --git a\/src\/app\.ts b\/src\/app\.ts/);
  assert.match(diff, /-const retries = 3;/);
  assert.match(diff, /\+const retries = 5;/);

  const capped = await git.taskDiff("task-9", 50);
  assert.ok(capped.endsWith("…[diff truncated]"));
  assert.ok(capped.length < 120);
});

test("status reports a dirty tree, untracked files and the branch", async () => {
  const root = await repo({ "src/app.ts": "v1\n" });
  assert.equal((await git.status()).clean, true);

  await fs.writeFile(path.join(root, "src/app.ts"), "v2\n");
  await fs.writeFile(path.join(root, "scratch.txt"), "notes\n");
  const status = await git.status();
  assert.equal(status.clean, false);
  assert.deepEqual(status.changed, ["src/app.ts"]);
  assert.deepEqual(status.untracked, ["scratch.txt"]);
  assert.equal(status.branch, "main");
});

test("available() is false outside a repository", async () => {
  const plain = await fs.mkdtemp(path.join(os.tmpdir(), "lc-plain-"));
  fake.setRoot(plain);
  assert.equal(await git.available(), false);
});
