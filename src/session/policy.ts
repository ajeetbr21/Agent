export interface SessionBudget {
  readonly maxContextTokens: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly rotateWhenBudgetRemainingBelow: number;
}

export interface SessionPolicy {
  readonly compactEveryPrompts: number;
  readonly budget: SessionBudget;
}

export interface SessionUsage {
  readonly promptCount: number;
  readonly inputTokensUsed: number;
  readonly outputTokensUsed: number;
}

export type SessionAction = "continue" | "compact" | "rotate";

/**
 * Global upper bounds. In practice each provider's own conversation window (its
 * `maxSessionChars`, see capBudgetToWindow) is the tighter limit, so a chat is only rotated when
 * that provider's window is nearly full.
 */
export const defaultSessionPolicy: SessionPolicy = {
  compactEveryPrompts: 10,
  budget: {
    maxContextTokens: 1_000_000,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 400_000,
    rotateWhenBudgetRemainingBelow: 0.1
  }
};

/** Characters per approximate token (matches estimateTokens). */
export const CHARS_PER_TOKEN = 4;

/**
 * Clamp a budget to one provider's conversation window (in approximate tokens), so rotation happens
 * before the provider itself cuts the conversation off.
 */
export function capBudgetToWindow(budget: SessionBudget, windowTokens: number | undefined): SessionBudget {
  if (!windowTokens || !Number.isFinite(windowTokens) || windowTokens <= 0) {
    return budget;
  }
  const cap = Math.trunc(windowTokens);
  return {
    ...budget,
    maxContextTokens: Math.min(budget.maxContextTokens, cap),
    maxInputTokens: Math.min(budget.maxInputTokens, cap),
    maxOutputTokens: Math.min(budget.maxOutputTokens, cap)
  };
}

/** Usage for a brand-new chat whose first message is `prompt` (after a rotate). */
export function startFreshSession(prompt: string): SessionUsage {
  return applyPromptUsage({ promptCount: 0, inputTokensUsed: 0, outputTokensUsed: 0 }, prompt);
}

export function estimateTokens(text: string): number {
  if (text.trim().length === 0) {
    return 0;
  }

  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function decideNextSessionAction(
  usage: SessionUsage,
  policy: SessionPolicy = defaultSessionPolicy
): SessionAction {
  if (isBudgetLow(usage, policy)) {
    return "rotate";
  }

  if (usage.promptCount > 0 && usage.promptCount % policy.compactEveryPrompts === 0) {
    return "compact";
  }

  return "continue";
}

export function applyPromptUsage(usage: SessionUsage, prompt: string): SessionUsage {
  return {
    ...usage,
    promptCount: usage.promptCount + 1,
    inputTokensUsed: usage.inputTokensUsed + estimateTokens(prompt)
  };
}

export function applyResponseUsage(usage: SessionUsage, response: string): SessionUsage {
  return {
    ...usage,
    outputTokensUsed: usage.outputTokensUsed + estimateTokens(response)
  };
}

function isBudgetLow(usage: SessionUsage, policy: SessionPolicy): boolean {
  const inputRemaining = remainingRatio(usage.inputTokensUsed, policy.budget.maxInputTokens);
  const outputRemaining = remainingRatio(usage.outputTokensUsed, policy.budget.maxOutputTokens);
  const contextRemaining = remainingRatio(
    usage.inputTokensUsed + usage.outputTokensUsed,
    policy.budget.maxContextTokens
  );
  const threshold = policy.budget.rotateWhenBudgetRemainingBelow;

  return inputRemaining <= threshold || outputRemaining <= threshold || contextRemaining <= threshold;
}

function remainingRatio(used: number, max: number): number {
  if (max <= 0) {
    return 0;
  }

  return Math.max(0, (max - used) / max);
}
