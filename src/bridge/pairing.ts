import { createHash, randomBytes, timingSafeEqual } from "crypto";

/**
 * The token every LeechCode install used to share (it was hard-coded in the browser extension).
 * It is public, so it must never be accepted as a real pairing secret.
 */
export const LEGACY_BRIDGE_TOKEN = "webchat-dev-token";

/** Minimum length for a user-supplied override token. Generated tokens are 43 chars. */
export const MIN_BRIDGE_TOKEN_LENGTH = 24;

/** 32 random bytes, base64url-encoded (43 chars, URL/query safe). */
export function generatePairingToken(): string {
  return randomBytes(32).toString("base64url");
}

/** True when a configured token is strong enough to be used instead of the generated one. */
export function isUsableOverrideToken(token: string | undefined): token is string {
  const trimmed = token?.trim() ?? "";
  return trimmed.length >= MIN_BRIDGE_TOKEN_LENGTH && trimmed !== LEGACY_BRIDGE_TOKEN;
}

export type BridgeTokenSource = "setting" | "stored" | "generated";

export interface ResolvedBridgeToken {
  readonly token: string;
  readonly source: BridgeTokenSource;
  /** Set when the `webchat.bridge.token` setting holds a value that was ignored (weak or legacy). */
  readonly ignoredSetting?: "legacy" | "too-short";
}

/**
 * Pick the token the bridge should require:
 * 1. an explicit, strong `webchat.bridge.token` setting (advanced override),
 * 2. otherwise the per-install token already kept in secret storage,
 * 3. otherwise a freshly generated one (the caller must persist it).
 */
export function resolveBridgeToken(
  configured: string | undefined,
  stored: string | undefined,
  generate: () => string = generatePairingToken
): ResolvedBridgeToken {
  const trimmed = configured?.trim() ?? "";
  let ignoredSetting: ResolvedBridgeToken["ignoredSetting"];

  if (trimmed) {
    if (isUsableOverrideToken(trimmed)) {
      return { token: trimmed, source: "setting" };
    }
    ignoredSetting = trimmed === LEGACY_BRIDGE_TOKEN ? "legacy" : "too-short";
  }

  if (stored && isUsableOverrideToken(stored)) {
    return { token: stored, source: "stored", ignoredSetting };
  }

  return { token: generate(), source: "generated", ignoredSetting };
}

/** Constant-time token comparison (hashing first so differing lengths don't leak via timing). */
export function tokensMatch(provided: string | undefined | null, expected: string): boolean {
  if (typeof provided !== "string" || provided.length === 0 || expected.length === 0) {
    return false;
  }
  const a = createHash("sha256").update(provided, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/**
 * Browsers always send an Origin header on WebSocket upgrades. Only browser-extension contexts
 * (the MV3 offscreen document) may connect; ordinary web pages — including a provider page or any
 * site the user visits — are refused even if they somehow learned the token. Non-browser local
 * clients (Node scripts, tests) send no Origin and are allowed through to the token check.
 */
export function isAllowedBridgeOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === "") {
    return true;
  }
  return /^(chrome-extension|moz-extension|safari-web-extension):\/\/[a-z0-9-]+\/?$/i.test(origin);
}
