import test from "node:test";
import assert from "node:assert/strict";
import { parseStatus, parseTaskCommits, toBranchName, toCommitMessage } from "../workspace/gitNaming";
import { buildFixPrompt, buildReviewPrompt, describeReview, readReviewOutcome } from "../agent/reviewPrompt";

test("toBranchName makes a readable, valid branch from an objective", () => {
  assert.equal(toBranchName("Add a login form with validation"), "leechcode/add-a-login-form-with-validation");
  assert.equal(toBranchName("Fix bug #123 in API/client!"), "leechcode/fix-bug-123-in-api-client");
  assert.equal(toBranchName("  Refactor   the   parser  "), "leechcode/refactor-the-parser");
  assert.equal(toBranchName("Don't break \"quotes\""), "leechcode/dont-break-quotes");
  assert.equal(toBranchName(""), "leechcode/task");
  assert.equal(toBranchName("!!!"), "leechcode/task");
  assert.equal(toBranchName("x", "team/ai"), "team/ai/x");
  assert.equal(toBranchName("y", "../evil"), "evil/y", "a prefix cannot escape into a path");

  const long = toBranchName("a".repeat(200));
  assert.ok(long.length <= "leechcode/".length + 40, `too long: ${long}`);
  assert.doesNotMatch(long, /-$/, "no trailing dash");
});

test("toCommitMessage builds a subject, a file list and a task trailer", () => {
  const message = toCommitMessage(
    "Added a retry helper to the API client so 5xx responses are retried.\nAlso updated the tests.",
    [{ path: "src/api.ts", action: "edit" }, { path: "src/api.test.ts", action: "write" }],
    "task-42"
  );

  const [subject, blank, ...rest] = message.split("\n");
  assert.equal(subject, "Added a retry helper to the API client so 5xx responses are retried.");
  assert.equal(blank, "");
  assert.ok(message.includes("- edit: src/api.ts"));
  assert.ok(message.includes("- write: src/api.test.ts"));
  assert.ok(message.trimEnd().endsWith("LeechCode-Task: task-42"));
  void rest;
});

test("toCommitMessage caps the subject and survives a useless summary", () => {
  const long = toCommitMessage("x".repeat(200), [], "t1");
  assert.ok(long.split("\n")[0].length <= 72);

  assert.match(toCommitMessage("", [], "t1").split("\n")[0], /LeechCode agent changes/);
  assert.match(toCommitMessage("   \n\n  ", [], "t1").split("\n")[0], /LeechCode agent changes/);
  // A markdown bullet is a common summary shape.
  assert.equal(toCommitMessage("- Fixed the parser", [], "t1").split("\n")[0], "Fixed the parser");
});

test("parseStatus separates changed, untracked and the branch", () => {
  const status = parseStatus([
    "## feature/login...origin/feature/login [ahead 2]",
    " M src/app.ts",
    "M  src/staged.ts",
    "?? notes.txt",
    "R  old.ts -> new.ts",
    "A  added.ts"
  ].join("\n"));

  assert.equal(status.branch, "feature/login");
  assert.deepEqual(status.changed, ["src/app.ts", "src/staged.ts", "new.ts", "added.ts"]);
  assert.deepEqual(status.untracked, ["notes.txt"]);
  assert.equal(status.clean, false);
});

test("parseStatus reports a clean tree and a detached head", () => {
  const clean = parseStatus("## main...origin/main\n");
  assert.equal(clean.clean, true);
  assert.equal(clean.branch, "main");
  assert.deepEqual(clean.changed, []);

  // Untracked files alone still count as clean for our purposes (we never commit them).
  const untrackedOnly = parseStatus("## main\n?? scratch.md\n");
  assert.equal(untrackedOnly.clean, true);
  assert.deepEqual(untrackedOnly.untracked, ["scratch.md"]);

  assert.equal(parseStatus("## HEAD (no branch)\n").branch, undefined);
  assert.equal(parseStatus("").clean, true);
});

test("parseTaskCommits reads hashes and ignores noise", () => {
  assert.deepEqual(
    parseTaskCommits("a1b2c3d Add login form\n9f8e7d6 Fix validation\n\nnot-a-commit line\n"),
    [
      { hash: "a1b2c3d", subject: "Add login form" },
      { hash: "9f8e7d6", subject: "Fix validation" }
    ]
  );
  assert.deepEqual(parseTaskCommits(""), []);
});

test("buildReviewPrompt forbids edits and includes the diff and intent", () => {
  const prompt = buildReviewPrompt({
    objective: "Retry 5xx responses in the API client",
    diff: "diff --git a/src/api.ts b/src/api.ts\n+  if (response.status >= 500) retry();",
    changedFiles: [{ path: "src/api.ts", action: "edit" }],
    implementerSummary: "Added a retry helper with exponential backoff.",
    verification: ["$ npm test (exit 0)"],
    implementerLabel: "ChatGPT"
  });

  assert.match(prompt, /REVIEW ONLY/);
  assert.match(prompt, /empty "files" array/);
  assert.match(prompt, /APPROVE \/ MINOR ISSUES \/ NEEDS CHANGES/);
  assert.match(prompt, /<objective>Retry 5xx responses in the API client<\/objective>/);
  assert.match(prompt, /by="ChatGPT"/);
  assert.match(prompt, /- edit: src\/api\.ts/);
  assert.match(prompt, /npm test \(exit 0\)/);
  assert.match(prompt, /\+ {2}if \(response\.status >= 500\) retry\(\);/);
  assert.match(prompt, /Ignore formatting and style preferences/);
});

test("buildReviewPrompt says so when there is no diff", () => {
  const prompt = buildReviewPrompt({ objective: "x", diff: "   ", changedFiles: [] });
  assert.match(prompt, /no diff available/);
});

test("readReviewOutcome reads the verdict in any of the expected shapes", () => {
  assert.equal(readReviewOutcome("APPROVE — looks correct", []).verdict, "approve");
  assert.equal(readReviewOutcome("approve", []).verdict, "approve");
  assert.equal(readReviewOutcome("MINOR ISSUES: two nits", []).verdict, "minor");
  assert.equal(readReviewOutcome("NEEDS CHANGES — the retry loop never exits", []).verdict, "changes");
  assert.equal(readReviewOutcome("needs_changes", []).verdict, "changes");
  assert.equal(readReviewOutcome("Looks fine to me", []).verdict, "unclear");

  const outcome = readReviewOutcome("NEEDS CHANGES", ["src/api.ts:12 — retry loop never exits", "  ", "src/api.ts:30 — error swallowed"]);
  assert.deepEqual(outcome.findings, ["src/api.ts:12 — retry loop never exits", "src/api.ts:30 — error swallowed"]);
});

test("describeReview summarises the verdict for the panel", () => {
  assert.match(describeReview(readReviewOutcome("APPROVE", []), "Claude"), /Claude approved the changes \(no findings\)/);
  assert.match(describeReview(readReviewOutcome("NEEDS CHANGES", ["a", "b"]), "Claude"), /changes are needed \(2 findings\)/);
  assert.match(describeReview(readReviewOutcome("MINOR ISSUES", ["a"]), "Gemini"), /minor issues \(1 finding\)/);
});

test("buildFixPrompt asks the implementer to verify before acting", () => {
  const prompt = buildFixPrompt(
    readReviewOutcome("NEEDS CHANGES — retry loop", ["src/api.ts:12 — infinite loop", "src/api.ts:30 — error swallowed"]),
    "Claude"
  );
  assert.match(prompt, /Claude/);
  assert.match(prompt, /1\. src\/api\.ts:12 — infinite loop/);
  assert.match(prompt, /2\. src\/api\.ts:30 — error swallowed/);
  assert.match(prompt, /a reviewer working from a diff can be wrong/);
  assert.match(prompt, /say briefly why/);
});
