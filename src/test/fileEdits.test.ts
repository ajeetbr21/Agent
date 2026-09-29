import test from "node:test";
import assert from "node:assert/strict";
import { applyTextEdits as applyTextEditsRaw, type TextEdit } from "../agent/fileEdits";
import { parseAgentResponse } from "../agent/toolProtocol";

type Applied = { ok: true; content: string; replacements: number };
type Failed = { ok: false; error: string; content: string; replacements: number };
/** Test helper: flatten the result union so assertions can read any field. */
function applyTextEdits(original: string, edits: readonly TextEdit[]): Applied | Failed {
  const result = applyTextEditsRaw(original, edits);
  return result.ok ? result : { ...result, content: "", replacements: 0 };
}

const SOURCE = [
  "export function add(a: number, b: number) {",
  "  return a + b;",
  "}",
  "",
  "export function sub(a: number, b: number) {",
  "  return a - b;",
  "}",
  ""
].join("\n");

test("applyTextEdits replaces a unique snippet", () => {
  const result = applyTextEdits(SOURCE, [{ find: "  return a + b;", replace: "  return a + b + 0;" }]);
  assert.ok(result.ok);
  assert.equal(result.content, SOURCE.replace("return a + b;", "return a + b + 0;"));
  assert.equal(result.replacements, 1);
});

test("applyTextEdits applies several edits in order", () => {
  const result = applyTextEdits(SOURCE, [
    { find: "function add(", replace: "function plus(" },
    { find: "function plus(a: number, b: number)", replace: "function plus(a: number, b = 1)" }
  ]);
  assert.ok(result.ok);
  assert.match(result.content, /function plus\(a: number, b = 1\)/);
});

test("applyTextEdits refuses ambiguous finds unless all is set", () => {
  const ambiguous = applyTextEdits(SOURCE, [{ find: "a: number, b: number", replace: "x: number, y: number" }]);
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.ok ? "" : ambiguous.error, /matches 2 places/);

  const all = applyTextEdits(SOURCE, [{ find: "a: number, b: number", replace: "x: number, y: number", all: true }]);
  assert.ok(all.ok);
  assert.equal(all.replacements, 2);
  assert.doesNotMatch(all.content, /a: number/);
});

test("applyTextEdits reports a missing find and changes nothing", () => {
  const result = applyTextEdits(SOURCE, [
    { find: "function add(", replace: "function plus(" },
    { find: "function mul(", replace: "function times(" }
  ]);
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /edit 2: "find" text was not found/);
});

test("applyTextEdits keeps CRLF files CRLF when the model sends LF text", () => {
  const crlf = SOURCE.replace(/\n/g, "\r\n");
  const result = applyTextEdits(crlf, [{ find: "  return a + b;\n}", replace: "  const sum = a + b;\n  return sum;\n}" }]);
  assert.ok(result.ok);
  assert.ok(result.content.includes("  const sum = a + b;\r\n  return sum;\r\n}"));
  assert.doesNotMatch(result.content.replace(/\r\n/g, ""), /\n/);
});

test("applyTextEdits tolerates trailing-whitespace differences", () => {
  const withTrailing = SOURCE.replace("  return a + b;", "  return a + b;   ");
  const result = applyTextEdits(withTrailing, [{ find: "  return a + b;\n}", replace: "  return b + a;\n}" }]);
  assert.ok(result.ok);
  assert.match(result.content, /return b \+ a;\n}/);
  assert.doesNotMatch(result.content, /return a \+ b/);
});

test("applyTextEdits rejects an empty find", () => {
  const result = applyTextEdits(SOURCE, [{ find: "", replace: "x" }]);
  assert.equal(result.ok, false);
});

test("parseAgentResponse reads edit actions with base64, plain and shorthand forms", () => {
  const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
  const response = parseAgentResponse(`Doing it.
<webchat_agent_response>
${JSON.stringify({
    summary: "edits",
    files: [
      { path: "src/a.ts", action: "edit", edits: [{ findBase64: b64("return a + b;"), replaceBase64: b64("return a + b + 1;") }] },
      { path: "src/b.ts", action: "edit", edits: [{ find: "x", replace: "y", all: true }] },
      { path: "src/c.ts", action: "edit", find: "old", replace: "new" }
    ]
  })}
</webchat_agent_response>`);

  assert.ok(response);
  assert.deepEqual(response?.files, [
    { path: "src/a.ts", action: "edit", edits: [{ find: "return a + b;", replace: "return a + b + 1;" }] },
    { path: "src/b.ts", action: "edit", edits: [{ find: "x", replace: "y", all: true }] },
    { path: "src/c.ts", action: "edit", edits: [{ find: "old", replace: "new" }] }
  ]);
});

test("parseAgentResponse rejects an edit without find/replace", () => {
  assert.throws(
    () => parseAgentResponse(`<webchat_agent_response>{"summary":"x","files":[{"path":"a.ts","action":"edit","edits":[{"find":"x"}]}]}</webchat_agent_response>`),
    /needs "find"/
  );
});

test("applyTextEdits leaves text outside the match byte-for-byte", () => {
  const mixed = "keep\r\nchange me\nkeep too\r\n";
  const result = applyTextEdits(mixed, [{ find: "change me", replace: "changed" }]);
  assert.ok(result.ok);
  assert.equal(result.content, "keep\r\nchanged\nkeep too\r\n");
});

test("applyTextEdits matches a find written with either line ending", () => {
  const crlf = "a\r\nb\r\nc\r\n";
  const lfFind = applyTextEdits(crlf, [{ find: "a\nb", replace: "a\nB" }]);
  assert.ok(lfFind.ok);
  assert.equal(lfFind.content, "a\r\nB\r\nc\r\n");

  const lf = "a\nb\nc\n";
  const crlfFind = applyTextEdits(lf, [{ find: "a\r\nb", replace: "a\r\nB" }]);
  assert.ok(crlfFind.ok);
  assert.equal(crlfFind.content, "a\nB\nc\n");
});

test("applyTextEdits deletes whole lines without leaving a blank line", () => {
  const source = "one\ntwo\nthree\n";
  const exact = applyTextEdits(source, [{ find: "two\n", replace: "" }]);
  assert.ok(exact.ok);
  assert.equal(exact.content, "one\nthree\n");

  // Same edit when the file has trailing whitespace (the tolerant pass).
  const loose = applyTextEdits("one\ntwo   \nthree\n", [{ find: "two\n", replace: "" }]);
  assert.ok(loose.ok);
  assert.equal(loose.content, "one\nthree\n");
});

test("applyTextEdits with all:true also replaces trailing-whitespace variants", () => {
  const source = "x = 1;\nx = 1;   \nx = 1;\n";
  const result = applyTextEdits(source, [{ find: "x = 1;", replace: "x = 2;", all: true }]);
  assert.ok(result.ok);
  assert.equal(result.replacements, 3);
  assert.doesNotMatch(result.content, /x = 1;/);
});

test("applyTextEdits treats regex characters in find literally", () => {
  const source = "const re = /a+b*/;\nconst other = 1;\n";
  const result = applyTextEdits(source, [{ find: "/a+b*/", replace: "/c?/" }]);
  assert.ok(result.ok);
  assert.equal(result.content, "const re = /c?/;\nconst other = 1;\n");
});

test("parseAgentResponse rejects truncated or corrupted base64", () => {
  const valid = Buffer.from("return a + b;", "utf8").toString("base64");
  const truncated = valid.slice(0, valid.length - 3);
  assert.throws(
    () => parseAgentResponse(`<webchat_agent_response>${JSON.stringify({
      summary: "x",
      files: [{ path: "a.ts", action: "edit", edits: [{ findBase64: truncated, replaceBase64: valid }] }]
    })}</webchat_agent_response>`),
    /not valid base64/
  );
  // Whitespace inside base64 is tolerated (chat UIs wrap long lines).
  const wrapped = `${valid.slice(0, 8)}\n${valid.slice(8)}`;
  const response = parseAgentResponse(`<webchat_agent_response>${JSON.stringify({
    summary: "x",
    files: [{ path: "a.ts", action: "edit", edits: [{ findBase64: wrapped, replaceBase64: valid }] }]
  })}</webchat_agent_response>`);
  assert.equal(response?.files[0].edits?.[0].find, "return a + b;");
});
