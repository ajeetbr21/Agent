import test from "node:test";
import assert from "node:assert/strict";
import {
  chooseFailoverProvider,
  createRequestState,
  describePhase,
  isFailure,
  isInCooldown,
  isSafeToRetryElsewhere,
  isTerminal,
  recordProviderResult,
  reduceRequest,
  type ProviderHealth,
  type RequestEvent,
  type RequestState
} from "../webchat/taskState";
import { buildContinuationPrompt, describeContinuation, type ContinuationPackage } from "../webchat/continuation";

function run(events: readonly RequestEvent[], providerId = "chatgpt"): RequestState {
  return events.reduce<RequestState>((state, event) => reduceRequest(state, event), createRequestState("t1", providerId));
}

const pageState = (state: string, detail?: string): RequestEvent => ({ kind: "page-state", state, detail });

test("a successful turn walks dispatched → accepted → streaming → completed", () => {
  const state = run([
    { kind: "dispatched", providerId: "chatgpt", delivered: true },
    pageState("ready"),
    pageState("submitted"),
    { kind: "delta" },
    { kind: "response-done" },
    { kind: "parsed" }
  ]);

  assert.equal(state.phase, "completed");
  assert.ok(isTerminal(state.phase));
  assert.equal(isFailure(state.phase), false);
  assert.deepEqual(
    state.history.map((entry) => entry.phase),
    ["dispatched", "accepted", "streaming", "responded", "completed"]
  );
});

test("a failure before the page submits is safe to retry on another provider", () => {
  // "submitting" means the content script is still trying (e.g. the input was covered and it is
  // retrying) — the provider has NOT received the prompt, so this must stay safe to retry.
  const attempts: RequestEvent[][] = [[], [pageState("ready")], [pageState("submitting", "input was covered; retrying")]];
  for (const before of attempts) {
    const state = run([{ kind: "dispatched", providerId: "chatgpt", delivered: true }, ...before, pageState("blocked", "Could not find the chat input")]);
    assert.equal(state.phase, "failed_before_accept");
    assert.equal(state.detail, "Could not find the chat input");
    assert.ok(isSafeToRetryElsewhere(state.phase));
  }

  // Nothing was even delivered to a browser.
  const undelivered = run([{ kind: "dispatched", providerId: "chatgpt", delivered: false }]);
  assert.equal(undelivered.phase, "failed_before_accept");
  assert.ok(isSafeToRetryElsewhere(undelivered.phase));
});

test("a failure after submitting is ambiguous, never auto-retried", () => {
  for (const failure of [pageState("blocked", "no response"), { kind: "transport-error", detail: "tab closed" } as RequestEvent, { kind: "timeout" } as RequestEvent]) {
    const state = run([
      { kind: "dispatched", providerId: "chatgpt", delivered: true },
      pageState("submitted"),
      failure
    ]);
    assert.equal(state.phase, "ambiguous", JSON.stringify(failure));
    assert.equal(isSafeToRetryElsewhere(state.phase), false);
    assert.ok(isFailure(state.phase));
  }

  // Mid-stream loss is ambiguous too: the provider was already working.
  const midStream = run([
    { kind: "dispatched", providerId: "chatgpt", delivered: true },
    pageState("submitted"),
    { kind: "delta" },
    { kind: "transport-error", detail: "browser disconnected" }
  ]);
  assert.equal(midStream.phase, "ambiguous");
});

test("a prompt left sitting in the input box is not safe to retry elsewhere", () => {
  // Auto-submit off: the user could still press send, which would duplicate the work.
  const state = run([
    { kind: "dispatched", providerId: "chatgpt", delivered: true },
    pageState("prompt-inserted"),
    { kind: "timeout", detail: "no response" }
  ]);
  assert.equal(state.phase, "ambiguous");
  assert.equal(isSafeToRetryElsewhere(state.phase), false);
});

test("login walls and limits are classified by how far the request got", () => {
  const beforeSubmit = run([{ kind: "dispatched", providerId: "chatgpt", delivered: true }, pageState("login-required")]);
  assert.equal(beforeSubmit.phase, "failed_before_accept");

  const afterSubmit = run([
    { kind: "dispatched", providerId: "chatgpt", delivered: true },
    pageState("submitted"),
    pageState("limit-hit", "message limit reached")
  ]);
  assert.equal(afterSubmit.phase, "ambiguous");
});

test("a prompt the page chose not to send is never treated as accepted", () => {
  // submitPrompt reports submitted:false while another reply is still streaming.
  const state = run([
    { kind: "dispatched", providerId: "chatgpt", delivered: true },
    pageState("submitting", "trying"),
    pageState("prompt-inserted", "a response is still generating"),
    { kind: "timeout" }
  ]);
  assert.equal(state.phase, "ambiguous", "text is in the box, so a human could still send it");
  assert.equal(isSafeToRetryElsewhere(state.phase), false);
});

test("a malformed reply is not a transport failure (the repair stays in the same chat)", () => {
  const state = run([
    { kind: "dispatched", providerId: "chatgpt", delivered: true },
    pageState("submitted"),
    { kind: "response-done" },
    { kind: "parse-failed", detail: "invalid JSON" }
  ]);
  assert.equal(state.phase, "responded");
  assert.equal(isFailure(state.phase), false);
  assert.equal(isTerminal(state.phase), false);
});

test("terminal phases ignore later events", () => {
  const cancelled = run([
    { kind: "dispatched", providerId: "chatgpt", delivered: true },
    pageState("submitted"),
    { kind: "cancelled" },
    { kind: "delta" },
    { kind: "response-done" }
  ]);
  assert.equal(cancelled.phase, "cancelled");

  const completed = run([
    { kind: "dispatched", providerId: "chatgpt", delivered: true },
    pageState("submitted"),
    { kind: "parsed" },
    pageState("blocked", "late failure")
  ]);
  assert.equal(completed.phase, "completed");
});

test("every phase has a human description", () => {
  const phases = [
    "dispatched", "inserted", "accepted", "streaming", "responded",
    "completed", "failed_before_accept", "ambiguous", "cancelled"
  ] as const;
  for (const phase of phases) {
    assert.ok(describePhase(phase).length > 0, phase);
  }
});

test("provider health counts failures and cools a provider down", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  let health = recordProviderResult(undefined, "chatgpt", "failed", "blocked", now);
  assert.equal(health.consecutiveFailures, 1);
  assert.equal(isInCooldown(health, now), false, "one failure is not enough");

  health = recordProviderResult(health, "chatgpt", "failed", "blocked again", now);
  assert.equal(health.consecutiveFailures, 2);
  assert.ok(isInCooldown(health, now));
  assert.equal(isInCooldown(health, new Date(now.getTime() + 6 * 60_000)), false, "cooldown expires");

  assert.deepEqual(recordProviderResult(health, "chatgpt", "ok"), { providerId: "chatgpt", consecutiveFailures: 0 });
});

test("failover picks the first healthy provider that isn't the failed one", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const health = new Map<string, ProviderHealth>([
    ["claude", { providerId: "claude", consecutiveFailures: 2, cooldownUntil: new Date(now.getTime() + 60_000).toISOString() }]
  ]);

  assert.equal(chooseFailoverProvider(["chatgpt", "claude", "gemini"], "chatgpt", health, now), "gemini");
  assert.equal(chooseFailoverProvider(["chatgpt", "claude"], "chatgpt", health, now), "claude", "falls back rather than stalling");
  assert.equal(chooseFailoverProvider(["chatgpt"], "chatgpt", health, now), undefined);
  assert.equal(chooseFailoverProvider([], "chatgpt", new Map(), now), undefined);
});

test("the continuation prompt tells a fresh provider what is already done", () => {
  const pack: ContinuationPackage = {
    objective: "Add a retry helper to the API client",
    phase: "response streaming",
    workspaceName: "demo",
    changedFiles: [{ path: "src/api.ts", action: "edit" }],
    relevantFiles: ["src/api.ts", "src/api.test.ts"],
    toolResults: [{ label: "run npm test", output: "2 failing" }],
    errors: ["ChatGPT stopped responding after submitting"],
    summary: "The client wraps fetch; retries were requested for 5xx only.",
    permissions: "Full access: edits applied automatically, commands run automatically.",
    checkpoint: "1 undo step",
    previousRequest: { providerId: "chatgpt", phase: "failed after submitting", mayHaveActed: true }
  };

  const prompt = buildContinuationPrompt(pack);
  assert.match(prompt, /taking over a coding task/);
  assert.match(prompt, /<objective>Add a retry helper to the API client<\/objective>/);
  assert.match(prompt, /- edit: src\/api\.ts/);
  assert.match(prompt, /Commands listed above have already run/);
  assert.match(prompt, /may already have produced edits or commands/);
  assert.match(prompt, /1 undo step/);
  assert.match(describeContinuation(pack), /objective: Add a retry helper/);

  // When nothing reached the provider, the new one is told to start fresh.
  const safe = buildContinuationPrompt({
    ...pack,
    changedFiles: [],
    toolResults: [],
    previousRequest: { providerId: "chatgpt", phase: "failed before the provider saw it", mayHaveActed: false }
  });
  assert.match(safe, /never reached the provider/);
  assert.doesNotMatch(safe, /already_changed/);
});

test("the continuation prompt caps long tool output", () => {
  const prompt = buildContinuationPrompt({
    objective: "x",
    phase: "y",
    changedFiles: [],
    relevantFiles: [],
    toolResults: [{ label: "run build", output: "z".repeat(5000) }],
    errors: [],
    permissions: "Ask mode",
    previousRequest: { providerId: "claude", phase: "failed", mayHaveActed: false }
  });
  assert.ok(prompt.includes("…[truncated]"));
  assert.ok(prompt.length < 4000);
});
