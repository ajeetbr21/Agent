import type { WebChatProvider } from "./types";

/**
 * A user-defined chat site ("any AI"). Only `label` and `url` are required; selectors are optional
 * hints — the browser extension falls back to generic heuristics, and selectors can also be picked
 * on the page itself via the right-click menu.
 */
export interface CustomProviderConfig {
  readonly id?: string;
  readonly label: string;
  readonly url: string;
  readonly inputSelector?: string;
  readonly submitSelector?: string;
  readonly responseSelector?: string;
  readonly maxMessageChars?: number;
  readonly maxSessionChars?: number;
}

/** What the browser extension needs to drive a custom site. Synced over the bridge. */
export interface CustomProviderAdapter {
  readonly id: string;
  readonly label: string;
  readonly chatUrl: string;
  readonly host: string;
  /** Match pattern for chrome.permissions / scripting, e.g. "https://chat.z.ai/*". */
  readonly matchPattern: string;
  readonly inputSelectors: readonly string[];
  readonly submitSelectors: readonly string[];
  readonly assistantSelectors: readonly string[];
}

export interface CustomProviderResult {
  readonly providers: readonly WebChatProvider[];
  readonly adapters: readonly CustomProviderAdapter[];
  readonly errors: readonly string[];
}

const DEFAULT_MAX_MESSAGE_CHARS = 12000;
const DEFAULT_MAX_SESSION_CHARS = 200000;
const MAX_SELECTOR_LENGTH = 500;

/**
 * Validate and normalize the `webchat.customProviders` setting. Invalid entries are dropped with a
 * human-readable error instead of breaking the whole list.
 */
export function parseCustomProviders(
  raw: unknown,
  reservedIds: ReadonlySet<string>,
  reservedHosts: ReadonlySet<string>
): CustomProviderResult {
  const providers: WebChatProvider[] = [];
  const adapters: CustomProviderAdapter[] = [];
  const errors: string[] = [];
  const seenIds = new Set<string>();
  const seenHosts = new Set<string>();

  if (raw === undefined || raw === null) {
    return { providers, adapters, errors };
  }
  if (!Array.isArray(raw)) {
    return { providers, adapters, errors: ["webchat.customProviders must be a list."] };
  }

  raw.forEach((entry, index) => {
    const where = `Custom AI #${index + 1}`;
    if (typeof entry !== "object" || entry === null) {
      errors.push(`${where}: must be an object with "label" and "url".`);
      return;
    }
    const value = entry as Record<string, unknown>;
    const label = typeof value.label === "string" ? value.label.trim() : "";
    const urlText = typeof value.url === "string" ? value.url.trim() : "";

    if (!label) {
      errors.push(`${where}: "label" is required.`);
      return;
    }

    const url = parseChatUrl(urlText);
    if (!url) {
      errors.push(`${label}: "url" must be a full https:// address (http:// only for localhost).`);
      return;
    }

    const host = url.hostname.toLowerCase();
    if (reservedHosts.has(host)) {
      errors.push(`${label}: ${host} is already a built-in provider.`);
      return;
    }
    if (seenHosts.has(host)) {
      errors.push(`${label}: ${host} is listed twice.`);
      return;
    }

    const id = normalizeId(typeof value.id === "string" && value.id.trim() ? value.id : host);
    if (!id || reservedIds.has(id) || seenIds.has(id)) {
      errors.push(`${label}: id "${id}" is empty or already used.`);
      return;
    }

    seenIds.add(id);
    seenHosts.add(host);

    const maxMessageChars = positiveInt(value.maxMessageChars) ?? DEFAULT_MAX_MESSAGE_CHARS;
    const maxSessionChars = positiveInt(value.maxSessionChars) ?? DEFAULT_MAX_SESSION_CHARS;

    providers.push({
      id,
      label,
      host,
      chatUrl: url.toString(),
      maxMessageChars,
      maxSessionChars,
      tags: ["chat", "custom"],
      imageSupport: "none",
      models: [],
      custom: true
    });
    adapters.push({
      id,
      label,
      chatUrl: url.toString(),
      host,
      matchPattern: `${url.protocol}//${host}/*`,
      inputSelectors: selectorList(value.inputSelector),
      submitSelectors: selectorList(value.submitSelector),
      assistantSelectors: selectorList(value.responseSelector)
    });
  });

  return { providers, adapters, errors };
}

function parseChatUrl(text: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol === "https:" || (url.protocol === "http:" && isLocal)) {
    return url.username || url.password ? undefined : url;
  }
  return undefined;
}

export function normalizeId(text: string): string {
  return text
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined;
}

/** Accepts a single selector string (comma-separated lists stay one CSS selector) or an array. */
function selectorList(value: unknown): string[] {
  const items = Array.isArray(value) ? value : [value];
  return items
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item.length <= MAX_SELECTOR_LENGTH);
}
