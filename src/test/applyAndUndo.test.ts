import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { installFakeVscode } from "./helpers/fakeVscode";

// Must be installed before the workspace module (which imports "vscode") is loaded.
const fake = installFakeVscode();
// eslint-disable-next-line @typescript-eslint/no-require-imports
const workspace = require("../workspace/applyAgentChanges") as typeof import("../workspace/applyAgentChanges");

async function setup(files: Record<string, string>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lc-apply-"));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "lc-storage-"));
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), content);
  }
  fake.setRoot(root);
  // The code only uses context.globalStorageUri.
  const { Uri } = require("vscode") as { Uri: { file(p: string): unknown } };
  const context = { globalStorageUri: Uri.file(storage) } as never;
  const read = (rel: string) => fs.readFile(path.join(root, rel), "utf8");
  const exists = (rel: string) => fs.access(path.join(root, rel)).then(() => true, () => false);
  return { root, context, read, exists };
}

test("apply writes, edits and deletes; undo restores everything", async () => {
  const { context, read, exists } = await setup({
    "src/app.ts": "const retries = 3;\nexport function run() {\n  return retries;\n}\n",
    "src/old.ts": "legacy\n",
    "README.md": "# Demo\n"
  });

  const applied = await workspace.applyAgentFileChanges([
    { path: "src/app.ts", action: "edit", edits: [{ find: "const retries = 3;", replace: "const retries = 5;" }] },
    { path: "src/new.ts", action: "write", content: "export const created = true;\n" },
    { path: "src/old.ts", action: "delete" }
  ], context);

  assert.equal(await read("src/app.ts"), "const retries = 5;\nexport function run() {\n  return retries;\n}\n");
  assert.equal(await read("src/new.ts"), "export const created = true;\n");
  assert.equal(await exists("src/old.ts"), false);
  assert.deepEqual(applied.map((change) => [change.path, change.action, change.existedBefore]), [
    ["src/app.ts", "edit", true],
    ["src/new.ts", "write", false],
    ["src/old.ts", "delete", true]
  ]);

  assert.deepEqual(await workspace.detectRevertConflicts(applied), []);
  const reverted = await workspace.revertAgentFileChanges(applied);
  assert.deepEqual(reverted, ["src/app.ts", "src/new.ts", "src/old.ts"]);
  assert.equal(await read("src/app.ts"), "const retries = 3;\nexport function run() {\n  return retries;\n}\n");
  assert.equal(await exists("src/new.ts"), false);
  assert.equal(await read("src/old.ts"), "legacy\n");
  assert.equal(await read("README.md"), "# Demo\n");
});

test("one failing edit means nothing from the response is written", async () => {
  const { context, read, exists } = await setup({ "src/a.ts": "alpha\n", "src/b.ts": "beta\n" });

  await assert.rejects(
    workspace.applyAgentFileChanges([
      { path: "src/a.ts", action: "edit", edits: [{ find: "alpha", replace: "ALPHA" }] },
      { path: "src/new.ts", action: "write", content: "new\n" },
      { path: "src/b.ts", action: "edit", edits: [{ find: "gamma", replace: "GAMMA" }] },
      { path: "src/missing.ts", action: "edit", edits: [{ find: "x", replace: "y" }] }
    ], context),
    (error: unknown) => {
      assert.ok(error instanceof workspace.AgentChangeError);
      const { problems } = error as { problems: readonly string[] };
      assert.equal(problems.length, 2);
      assert.match(problems[0], /^src\/b\.ts: edit 1: "find" text was not found/);
      assert.match(problems[1], /^src\/missing\.ts: cannot edit a file that does not exist/);
      return true;
    }
  );

  assert.equal(await read("src/a.ts"), "alpha\n");
  assert.equal(await read("src/b.ts"), "beta\n");
  assert.equal(await exists("src/new.ts"), false);
});

test("several entries for one file stack, and undo returns the true original", async () => {
  const { context, read } = await setup({ "src/a.ts": "one\ntwo\nthree\n" });

  const applied = await workspace.applyAgentFileChanges([
    { path: "src/a.ts", action: "edit", edits: [{ find: "one", replace: "ONE" }] },
    { path: "src/a.ts", action: "edit", edits: [{ find: "three", replace: "THREE" }] }
  ], context);

  assert.equal(await read("src/a.ts"), "ONE\ntwo\nTHREE\n");
  assert.equal(applied.length, 1);
  await workspace.revertAgentFileChanges(applied);
  assert.equal(await read("src/a.ts"), "one\ntwo\nthree\n");
});

test("undo detects files the user changed after the agent", async () => {
  const { root, context } = await setup({ "src/a.ts": "v1\n" });

  const applied = await workspace.applyAgentFileChanges([
    { path: "src/a.ts", action: "write", content: "v2 by agent\n" },
    { path: "src/b.ts", action: "write", content: "created by agent\n" }
  ], context);
  await fs.writeFile(path.join(root, "src/a.ts"), "v3 by user\n");

  assert.deepEqual(await workspace.detectRevertConflicts(applied), ["src/a.ts"]);
});

test("unsafe paths are rejected before anything is written", async () => {
  const { context, exists } = await setup({ "src/a.ts": "a\n" });
  await assert.rejects(
    workspace.applyAgentFileChanges([
      { path: "src/ok.ts", action: "write", content: "ok\n" },
      { path: "../outside.ts", action: "write", content: "nope\n" }
    ], context),
    /Refusing unsafe workspace path/
  );
  assert.equal(await exists("src/ok.ts"), false);
});

test("repository internals are never written", async () => {
  const { context, read } = await setup({ ".git/config": "[core]\n", "src/a.ts": "a\n" });
  for (const bad of [".git/config", ".git/hooks/pre-commit", "src/../.git/config", ".GIT/config"]) {
    await assert.rejects(
      workspace.applyAgentFileChanges([{ path: bad, action: "write", content: "x\n" }], context),
      /Refusing to modify repository internals/,
      bad
    );
  }
  assert.equal(await read(".git/config"), "[core]\n");
});

test("a write failure restores everything that was already written", async () => {
  const { root, context, read, exists } = await setup({ "src/a.ts": "original\n", "src/lib.ts": "lib\n" });

  // "src/lib.ts/inner.ts" can't be created because src/lib.ts is a file — the write phase fails there.
  await assert.rejects(
    workspace.applyAgentFileChanges([
      { path: "src/a.ts", action: "write", content: "changed\n" },
      { path: "src/created.ts", action: "write", content: "new\n" },
      { path: "src/lib.ts/inner.ts", action: "write", content: "boom\n" }
    ], context),
    (error: unknown) => {
      assert.ok(error instanceof workspace.AgentChangeError);
      assert.match(String((error as Error).message), /restored to its previous state/);
      return true;
    }
  );

  assert.equal(await read("src/a.ts"), "original\n", "earlier write must be rolled back");
  assert.equal(await exists("src/created.ts"), false, "created file must be removed");
  assert.equal(await read("src/lib.ts"), "lib\n");
  void root;
});

test("edits keep a file's dominant line ending and refuse non-UTF-8 files", async () => {
  const { root, context, read } = await setup({
    "crlf.txt": "one\r\ntwo\r\nthree\r\n",
    "mostly-lf.txt": "one\ntwo\r\nthree\nfour\n"
  });
  await fs.writeFile(path.join(root, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])); // "café\n" in Latin-1

  await workspace.applyAgentFileChanges([
    { path: "crlf.txt", action: "edit", edits: [{ find: "two", replace: "TWO" }] },
    { path: "mostly-lf.txt", action: "edit", edits: [{ find: "three", replace: "THREE" }] }
  ], context);

  assert.equal(await read("crlf.txt"), "one\r\nTWO\r\nthree\r\n", "CRLF file stays CRLF");
  assert.equal(await read("mostly-lf.txt"), "one\ntwo\r\nTHREE\nfour\n", "one stray CRLF must not convert the file");

  await assert.rejects(
    workspace.applyAgentFileChanges([{ path: "latin1.txt", action: "edit", edits: [{ find: "caf", replace: "CAF" }] }], context),
    /not valid UTF-8/
  );
  const bytes = await fs.readFile(path.join(root, "latin1.txt"));
  assert.deepEqual([...bytes], [0x63, 0x61, 0x66, 0xe9, 0x0a], "file must be untouched");
});

test("two spellings of one path are the same file for undo", async () => {
  const { context, read } = await setup({ "src/a.ts": "one\ntwo\n" });

  const applied = await workspace.applyAgentFileChanges([
    { path: "src/a.ts", action: "edit", edits: [{ find: "one", replace: "ONE" }] },
    { path: "./src/a.ts", action: "edit", edits: [{ find: "two", replace: "TWO" }] }
  ], context);

  assert.equal(applied.length, 1, "one entry per file");
  assert.equal(await read("src/a.ts"), "ONE\nTWO\n");
  assert.deepEqual(await workspace.detectRevertConflicts(applied), [], "no false conflict right after apply");
  await workspace.revertAgentFileChanges(applied);
  assert.equal(await read("src/a.ts"), "one\ntwo\n");
});

test("planning stacks several edits per file, so a preview matches apply", async () => {
  const { context } = await setup({ "src/a.ts": "import a from 'a';\n" });

  // The second edit only matches after the first one inserted its line.
  const planned = await workspace.planAgentFileChanges([
    { path: "src/a.ts", action: "edit", edits: [{ find: "import a from 'a';", replace: "import a from 'a';\nimport b from 'b';" }] },
    { path: "src/a.ts", action: "edit", edits: [{ find: "import b from 'b';", replace: "import b from 'b';\nimport c from 'c';" }] }
  ]);

  assert.equal(planned.length, 2);
  assert.equal(
    Buffer.from(planned[planned.length - 1].next ?? new Uint8Array()).toString("utf8"),
    "import a from 'a';\nimport b from 'b';\nimport c from 'c';\n"
  );
});
