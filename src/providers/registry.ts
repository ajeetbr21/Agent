import type { ProviderId, WebChatProvider } from "./types";
import { parseCustomProviders, type CustomProviderAdapter } from "./custom";

const builtInProviders: readonly WebChatProvider[] = [
  {
    id: "chatgpt",
    label: "ChatGPT",
    host: "chatgpt.com",
    chatUrl: "https://chatgpt.com/",
    maxMessageChars: 12000,
    maxSessionChars: 240000,
    tags: ["chat", "vision"],
    imageSupport: "limited",
    models: ["Auto", "Instant", "Thinking"],
    features: [{ id: "search", label: "Search", icon: "🔍" }]
  },
  {
    id: "claude",
    label: "Claude",
    host: "claude.ai",
    chatUrl: "https://claude.ai/new",
    maxMessageChars: 30000,
    maxSessionChars: 600000,
    tags: ["chat", "vision"],
    imageSupport: "limited",
    models: ["Opus", "Sonnet", "Haiku"]
  },
  {
    id: "gemini",
    label: "Gemini",
    host: "gemini.google.com",
    chatUrl: "https://gemini.google.com/app",
    maxMessageChars: 12000,
    maxSessionChars: 500000,
    tags: ["chat", "vision"],
    imageSupport: "generous",
    models: ["3 Flash", "3 Pro"]
  },
  {
    id: "qwen",
    label: "Qwen",
    host: "chat.qwen.ai",
    chatUrl: "https://chat.qwen.ai/",
    maxMessageChars: 8000,
    maxSessionChars: 120000,
    tags: ["chat", "vision"],
    imageSupport: "generous",
    models: ["Qwen3-Max", "Qwen3-Coder", "Qwen3-VL"]
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    host: "chat.deepseek.com",
    chatUrl: "https://chat.deepseek.com/",
    maxMessageChars: 12000,
    maxSessionChars: 200000,
    tags: ["chat"],
    imageSupport: "none",
    models: ["DeepSeek", "DeepThink"],
    features: [
      { id: "search", label: "Search", icon: "🔍" },
      { id: "think", label: "DeepThink", icon: "🧠" }
    ]
  },
  {
    id: "aistudio",
    label: "Google AI Studio",
    host: "aistudio.google.com",
    chatUrl: "https://aistudio.google.com/prompts/new_chat",
    maxMessageChars: 100000,
    maxSessionChars: 4000000,
    tags: ["chat", "vision", "images"],
    imageSupport: "unlimited",
    models: ["Gemini 3 Pro", "Gemini 3 Flash"]
  },
  {
    id: "mock",
    label: "Mock WebChat",
    host: "127.0.0.1",
    chatUrl: "http://127.0.0.1:53452/",
    maxMessageChars: 1000000,
    maxSessionChars: 8000000,
    tags: ["chat"],
    imageSupport: "none",
    models: []
  }
];

let customProviders: readonly WebChatProvider[] = [];
let customAdapters: readonly CustomProviderAdapter[] = [];

/**
 * Replace the user-defined providers (from `webchat.customProviders`). Returns validation errors
 * for entries that were skipped.
 */
export function setCustomProviders(raw: unknown): readonly string[] {
  const result = parseCustomProviders(
    raw,
    new Set(builtInProviders.map((provider) => provider.id)),
    new Set(builtInProviders.map((provider) => provider.host))
  );
  customProviders = result.providers;
  customAdapters = result.adapters;
  return result.errors;
}

export function listCustomAdapters(): readonly CustomProviderAdapter[] {
  return customAdapters;
}

export function listProviders(): readonly WebChatProvider[] {
  return [...builtInProviders, ...customProviders];
}

export function getProvider(id: ProviderId | string): WebChatProvider | undefined {
  return listProviders().find((provider) => provider.id === id);
}

/** Find the provider (built-in or custom) that owns a hostname, including subdomains. */
export function findProviderByHost(hostname: string): WebChatProvider | undefined {
  const host = hostname.toLowerCase();
  return listProviders().find((provider) => host === provider.host || host.endsWith(`.${provider.host}`));
}
