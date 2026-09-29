import test from "node:test";
import assert from "node:assert/strict";
import {
  applyPromptUsage,
  applyResponseUsage,
  capBudgetToWindow,
  decideNextSessionAction,
  defaultSessionPolicy,
  estimateTokens,
  startFreshSession
} from "../session/policy";

test("estimateTokens uses a conservative character approximation", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
});

test("decideNextSessionAction asks for compaction every tenth prompt by default", () => {
  assert.equal(defaultSessionPolicy.compactEveryPrompts, 10);
  assert.equal(decideNextSessionAction({ promptCount: 10, inputTokensUsed: 10, outputTokensUsed: 10 }), "compact");
  assert.equal(decideNextSessionAction({ promptCount: 5, inputTokensUsed: 10, outputTokensUsed: 10 }), "continue");
});

test("decideNextSessionAction rotates before compacting when budget is low", () => {
  const policy = { ...defaultSessionPolicy, budget: capBudgetToWindow(defaultSessionPolicy.budget, 120000) };
  assert.equal(
    decideNextSessionAction({ promptCount: 10, inputTokensUsed: 119000, outputTokensUsed: 10 }, policy),
    "rotate"
  );
});

test("default budget is far larger than the old 150k/120k/30k", () => {
  assert.ok(defaultSessionPolicy.budget.maxContextTokens >= 1_000_000);
  assert.ok(defaultSessionPolicy.budget.maxOutputTokens >= 400_000);
  // A long, busy session (hundreds of k tokens) no longer rotates on the global budget alone.
  assert.equal(
    decideNextSessionAction({ promptCount: 7, inputTokensUsed: 300_000, outputTokensUsed: 150_000 }),
    "continue"
  );
});

test("capBudgetToWindow clamps every budget to the provider's conversation window", () => {
  assert.deepEqual(capBudgetToWindow(defaultSessionPolicy.budget, 100_000), {
    maxContextTokens: 100_000,
    maxInputTokens: 100_000,
    maxOutputTokens: 100_000,
    rotateWhenBudgetRemainingBelow: defaultSessionPolicy.budget.rotateWhenBudgetRemainingBelow
  });
  assert.deepEqual(capBudgetToWindow(defaultSessionPolicy.budget, undefined), defaultSessionPolicy.budget);
  assert.deepEqual(capBudgetToWindow(defaultSessionPolicy.budget, 0), defaultSessionPolicy.budget);
});

test("after a rotate the fresh chat starts a new budget (regression: a new tab for every prompt)", () => {
  const policy = { ...defaultSessionPolicy, budget: capBudgetToWindow(defaultSessionPolicy.budget, 10_000) };
  const exhausted = { promptCount: 40, inputTokensUsed: 9_500, outputTokensUsed: 300 };
  assert.equal(decideNextSessionAction(exhausted, policy), "rotate");

  // The rotate prompt is the first message of the new chat...
  let usage = startFreshSession("x".repeat(4_000)); // ~1000 tokens
  assert.deepEqual(usage, { promptCount: 1, inputTokensUsed: 1000, outputTokensUsed: 0 });
  // ...so the following turns continue in that chat instead of rotating again.
  usage = applyResponseUsage(usage, "y".repeat(2_000));
  assert.equal(decideNextSessionAction(usage, policy), "continue");
  usage = applyPromptUsage(usage, "z".repeat(2_000));
  assert.equal(decideNextSessionAction(usage, policy), "continue");
});

test("decideNextSessionAction rotates when total context budget is low", () => {
  assert.equal(
    decideNextSessionAction(
      {
        promptCount: 2,
        inputTokensUsed: 80,
        outputTokensUsed: 15
      },
      {
        compactEveryPrompts: 5,
        budget: {
          maxContextTokens: 100,
          maxInputTokens: 1000,
          maxOutputTokens: 1000,
          rotateWhenBudgetRemainingBelow: 0.1
        }
      }
    ),
    "rotate"
  );
});

test("usage helpers increment prompt and response budgets", () => {
  const afterPrompt = applyPromptUsage(
    { promptCount: 0, inputTokensUsed: 0, outputTokensUsed: 0 },
    "12345678"
  );
  const afterResponse = applyResponseUsage(afterPrompt, "1234");

  assert.deepEqual(afterResponse, {
    promptCount: 1,
    inputTokensUsed: 2,
    outputTokensUsed: 1
  });
});
