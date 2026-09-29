/**
 * Local request lifecycle for one dispatched prompt.
 *
 * The browser page is an untrusted, lossy transport: a tab can close, a login wall can appear, the
 * DOM can change. To recover safely the IDE has to know *how far* a request got, because the answer
 * decides whether the same work may be sent to another provider. Replaying a prompt that the first
 * provider already accepted can duplicate file edits and commands, so failover is only ever
 * automatic for failures that happened **before** the page accepted the prompt.
 *
 * Pure (no vscode import) so it is unit-testable.
 */

export type RequestPhase =
  /** Sent to the bridge; no page feedback yet. */
  | "dispatched"
  /** Typed into the provider's input box but not submitted (auto-submit off). */
  | "inserted"
  /** The page clicked send — the provider may already be working. */
  | "accepted"
  /** Response text is arriving. */
  | "streaming"
  /** The full reply arrived (it may still fail to parse). */
  | "responded"
  /** A structured response was parsed and acted on. */
  | "completed"
  /** Failed before the provider could have seen the prompt — safe to send elsewhere. */
  | "failed_before_accept"
  /** Submitted, then transport/page failure: the provider MAY have acted. Needs a decision. */
  | "ambiguous"
  /** The user cancelled this turn. */
  | "cancelled";

export interface RequestState {
  readonly turnId: string;
  readonly providerId: string;
  readonly phase: RequestPhase;
  /** Why the request is in a failed/ambiguous phase. */
  readonly detail?: string;
  /** Page states seen, oldest first (a short audit trail shown in the panel / output channel). */
  readonly history: readonly { readonly phase: RequestPhase; readonly at: string; readonly detail?: string }[];
}

export type RequestEvent =
  | { readonly kind: "dispatched"; readonly providerId: string; readonly delivered: boolean }
  | { readonly kind: "page-state"; readonly state: string; readonly detail?: string }
  | { readonly kind: "delta" }
  | { readonly kind: "response-done" }
  | { readonly kind: "parsed" }
  | { readonly kind: "parse-failed"; readonly detail?: string }
  | { readonly kind: "transport-error"; readonly detail?: string }
  | { readonly kind: "cancelled" }
  /** No page feedback within the grace period. */
  | { readonly kind: "timeout"; readonly detail?: string };

/** Phases from which nothing can have reached the provider's model. */
const PRE_ACCEPT: ReadonlySet<RequestPhase> = new Set(["dispatched", "failed_before_accept"]);

/** Phases that are still live (a later event can still move them forward). */
const ACTIVE: ReadonlySet<RequestPhase> = new Set(["dispatched", "inserted", "accepted", "streaming", "responded"]);

export function createRequestState(turnId: string, providerId: string, now = new Date()): RequestState {
  return {
    turnId,
    providerId,
    phase: "dispatched",
    history: [{ phase: "dispatched", at: now.toISOString() }]
  };
}

/** Fold one event into the request's state. Terminal phases ignore further events. */
export function reduceRequest(state: RequestState, event: RequestEvent, now = new Date()): RequestState {
  if (!ACTIVE.has(state.phase)) {
    return state;
  }

  const next = nextPhase(state, event);
  if (!next) {
    return state;
  }

  const detail = "detail" in event ? event.detail : undefined;
  if (next === state.phase && detail === undefined) {
    return state;
  }
  return {
    ...state,
    phase: next,
    detail: next === state.phase ? state.detail : detail,
    history: [...state.history, { phase: next, at: now.toISOString(), detail }].slice(-40)
  };
}

function nextPhase(state: RequestState, event: RequestEvent): RequestPhase | undefined {
  switch (event.kind) {
    case "dispatched":
      // No browser received it, so the provider never saw it.
      return event.delivered ? "dispatched" : "failed_before_accept";
    case "page-state":
      return phaseForPageState(state, event.state);
    case "delta":
      return "streaming";
    case "response-done":
      return "responded";
    case "parsed":
      return "completed";
    case "parse-failed":
      // The provider answered; a repair prompt continues in the SAME chat, so this is not a failure
      // of the request itself.
      return "responded";
    case "transport-error":
    case "timeout":
      return failurePhase(state);
    case "cancelled":
      return "cancelled";
    default:
      return undefined;
  }
}

/**
 * Map a provider-page state to a phase. `submitted` is the acceptance point: the content script
 * reports it only after actually activating the send control, so from there on the provider may be
 * generating and the request must never be replayed elsewhere automatically.
 */
function phaseForPageState(state: RequestState, pageState: string): RequestPhase | undefined {
  switch (pageState) {
    case "ready":
      return undefined; // the tab announcing itself, not progress for this request
    case "prompt-inserted":
      return "inserted";
    case "submitting":
      // Reported while the content script is still trying (e.g. "the input was covered, retrying"),
      // so it is NOT acceptance — the prompt may never have reached the page.
      return undefined;
    case "submitted":
      return "accepted";
    case "streaming":
      return "streaming";
    case "complete":
      return "responded";
    case "cancelled":
      return "cancelled";
    case "blocked":
    case "login-required":
    case "limit-hit":
      return failurePhase(state);
    case "waiting-response":
      return undefined; // still waiting; the phase already says where we are
    default:
      return undefined;
  }
}

/**
 * A failure is only safe to retry elsewhere while the prompt cannot have reached the model.
 * `inserted` counts as unsafe: the text sits in the provider's input box and a human (or a retry)
 * could still submit it, which would duplicate the work.
 */
function failurePhase(state: RequestState): RequestPhase {
  return PRE_ACCEPT.has(state.phase) ? "failed_before_accept" : "ambiguous";
}

export function isTerminal(phase: RequestPhase): boolean {
  return !ACTIVE.has(phase);
}

export function isFailure(phase: RequestPhase): boolean {
  return phase === "failed_before_accept" || phase === "ambiguous";
}

/** True when the same prompt may be sent to another provider without risking duplicate work. */
export function isSafeToRetryElsewhere(phase: RequestPhase): boolean {
  return phase === "failed_before_accept";
}

/** One-line description for the panel, the output channel and failover prompts. */
export function describePhase(phase: RequestPhase): string {
  switch (phase) {
    case "dispatched":
      return "sent to the browser";
    case "inserted":
      return "typed into the chat box, not submitted";
    case "accepted":
      return "submitted to the provider";
    case "streaming":
      return "response streaming";
    case "responded":
      return "response received";
    case "completed":
      return "completed";
    case "failed_before_accept":
      return "failed before the provider saw it (safe to retry elsewhere)";
    case "ambiguous":
      return "failed after submitting — the provider may already have acted";
    case "cancelled":
      return "cancelled";
  }
}

// ---- provider health -----------------------------------------------------------------------------

export interface ProviderHealth {
  readonly providerId: string;
  readonly consecutiveFailures: number;
  /** ISO timestamp until which this provider is skipped for automatic failover. */
  readonly cooldownUntil?: string;
  readonly lastDetail?: string;
}

export const FAILURES_BEFORE_COOLDOWN = 2;
export const COOLDOWN_MS = 5 * 60_000;

export function recordProviderResult(
  health: ProviderHealth | undefined,
  providerId: string,
  outcome: "ok" | "failed",
  detail?: string,
  now = new Date()
): ProviderHealth {
  if (outcome === "ok") {
    return { providerId, consecutiveFailures: 0 };
  }
  const consecutiveFailures = (health?.consecutiveFailures ?? 0) + 1;
  const cooldownUntil = consecutiveFailures >= FAILURES_BEFORE_COOLDOWN
    ? new Date(now.getTime() + COOLDOWN_MS).toISOString()
    : health?.cooldownUntil;
  return { providerId, consecutiveFailures, cooldownUntil, lastDetail: detail };
}

export function isInCooldown(health: ProviderHealth | undefined, now = new Date()): boolean {
  return Boolean(health?.cooldownUntil && Date.parse(health.cooldownUntil) > now.getTime());
}

/**
 * Pick the next provider to try: the first configured candidate that isn't the failed one and isn't
 * cooling down. Falls back to a cooling-down candidate only if every option is cooling down, because
 * trying again is better than stalling the task.
 */
export function chooseFailoverProvider(
  candidates: readonly string[],
  failedProviderId: string,
  health: ReadonlyMap<string, ProviderHealth>,
  now = new Date()
): string | undefined {
  const others = candidates.filter((id) => id !== failedProviderId);
  return others.find((id) => !isInCooldown(health.get(id), now)) ?? others[0];
}
