import test from "node:test";
import assert from "node:assert/strict";
import {
  findSymbolPosition,
  formatDiagnostics,
  formatOpenEditors,
  formatReferences,
  formatSymbols
} from "../agent/contextFormat";
import { buildAgentToolInstructions, parseAgentResponse } from "../agent/toolProtocol";

test("formatDiagnostics lists errors first with counts and caps the list", () => {
  const text = formatDiagnostics([
    { path: "src/b.ts", line: 3, column: 1, severity: "warning", message: "unused variable 'x'", source: "eslint", code: "no-unused-vars" },
    { path: "src/a.ts", line: 10, column: 5, severity: "error", message: "Type 'string' is not assignable\n  to type 'number'.", source: "ts", code: "2322" },
    { path: "src/a.ts", line: 2, column: 1, severity: "error", message: "Cannot find name 'foo'.", source: "ts", code: "2304" }
  ], 2);

  assert.equal(text, [
    "Problems in the workspace: 2 errors, 1 warning",
    "src/a.ts:2:1 error: Cannot find name 'foo'. [ts 2304]",
    "src/a.ts:10:5 error: Type 'string' is not assignable to type 'number'. [ts 2322]",
    "…[1 more]"
  ].join("\n"));
  assert.match(formatDiagnostics([], 10, "src/a.ts"), /No problems in src\/a\.ts/);
});

test("formatOpenEditors marks the active file, unsaved changes and selection", () => {
  const text = formatOpenEditors([
    { path: "src/app.ts", active: true, dirty: true, selection: { startLine: 4, endLine: 9 } },
    { path: "README.md", active: false, dirty: false }
  ]);
  assert.equal(text, "Open editors (2):\nsrc/app.ts  (active, unsaved changes, selection lines 4-9)\nREADME.md");
  assert.equal(formatOpenEditors([]), "No files are open in the editor.");
});

test("formatSymbols and formatReferences describe locations", () => {
  assert.equal(
    formatSymbols("User", [{ name: "UserService", kind: "Class", path: "src/user.ts", line: 3, container: "services" }]),
    'Symbols matching "User" (1):\nClass UserService (in services) — src/user.ts:3'
  );
  assert.match(formatSymbols("Nope", []), /No symbols matching "Nope"/);

  const refs = formatReferences(
    "login",
    [{ path: "src/auth.ts", line: 5, column: 17, text: "export function login(user: User) {" }],
    [
      { path: "src/app.ts", line: 12, column: 3, text: "login(current);" },
      { path: "src/auth.test.ts", line: 8, column: 5, text: "await login(fake);" }
    ]
  );
  assert.match(refs, /^Definition of login:\nsrc\/auth\.ts:5:17  export function login/);
  assert.match(refs, /References to login \(2\):\nsrc\/app\.ts:12:3  login\(current\);/);
});

test("findSymbolPosition finds whole words and prefers the requested line", () => {
  const text = "const loginUser = 1;\nfunction login() {}\n\nlogin();\n";
  assert.deepEqual(findSymbolPosition(text, "login"), { line: 1, character: 9 });
  assert.deepEqual(findSymbolPosition(text, "login", 4), { line: 3, character: 0 });
  assert.deepEqual(findSymbolPosition(text, "loginUser"), { line: 0, character: 6 });
  assert.equal(findSymbolPosition(text, "logout"), undefined);
  assert.deepEqual(findSymbolPosition("const $el = 1;", "$el"), { line: 0, character: 6 });
});

test("parseAgentResponse reads the VS Code context tools", () => {
  const response = parseAgentResponse(`<webchat_agent_response>${JSON.stringify({
    summary: "look around",
    files: [],
    tools: [
      { name: "diagnostics" },
      { name: "diagnostics", path: "src/a.ts" },
      { name: "open_editors" },
      { name: "git_status" },
      { name: "git_diff", path: "src/a.ts", staged: true },
      { name: "symbols", query: "UserService" },
      { name: "references", path: "src/auth.ts", symbol: "login", line: 5 },
      { name: "symbols" },
      { name: "references", path: "src/auth.ts" }
    ]
  })}</webchat_agent_response>`);

  assert.deepEqual(response?.tools, [
    { name: "diagnostics", path: undefined },
    { name: "diagnostics", path: "src/a.ts" },
    { name: "open_editors" },
    { name: "git_status" },
    { name: "git_diff", path: "src/a.ts", staged: true },
    { name: "symbols", query: "UserService" },
    { name: "references", path: "src/auth.ts", symbol: "login", line: 5 }
  ]);
});

test("tool instructions advertise the context tools and the edit action", () => {
  const text = buildAgentToolInstructions({ maxContextTokens: 1000, compactEveryPrompts: 10, action: "continue", mode: "bypass" });
  for (const name of ["diagnostics", "open_editors", "git_status", "git_diff", "symbols", "references"]) {
    assert.ok(text.includes(`\\"name\\":\\"${name}\\"`) || text.includes(`"name":"${name}"`), `mentions ${name}`);
  }
  assert.match(text, /"action":"edit"/);
});
