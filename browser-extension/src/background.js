const SESSION_ID = "browser-extension";
const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const DEFAULT_BRIDGE_PORT = 53451;
// chrome.storage.local keys (written by options.html).
const STORAGE_PORT_KEY = "bridgePort";
const STORAGE_TOKEN_KEY = "bridgeToken";
const STORAGE_STATUS_KEY = "bridgeStatus";
const STORAGE_CUSTOM_KEY = "customProviders";
const CUSTOM_SCRIPT_ID = "webchat-custom-providers";
const CONTEXT_MENU_ROOT = "webchat.pick";
const CONTEXT_MENU_ROLES = {
  "webchat.pick.input": { role: "input", title: "Use as chat input" },
  "webchat.pick.submit": { role: "submit", title: "Use as Send button" },
  "webchat.pick.assistant": { role: "assistant", title: "Use as assistant reply" }
};
const PROVIDER_URL_PATTERNS = [
  "https://chatgpt.com/*",
  "https://claude.ai/*",
  "https://gemini.google.com/*",
  "https://chat.qwen.ai/*",
  "https://chat.deepseek.com/*",
  "https://aistudio.google.com/*",
  "http://127.0.0.1/*",
  "http://localhost/*"
];

let creatingOffscreenDocument;
let pendingPromptByTab = new Map();
const lastTabAliveReport = new Map();

chrome.runtime.onInstalled.addListener(async (details) => {
  void ensureBridge();
  chrome.alarms.create("webchat.bridge.reconnect", { periodInMinutes: 0.25 });
  createContextMenus();
  void registerCustomContentScripts();
  // First install: the extension can't connect until it has the IDE's pairing token.
  if (details?.reason === "install" && !(await getBridgeConfig()).token) {
    void chrome.runtime.openOptionsPage();
  }
});

chrome.action.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes[STORAGE_PORT_KEY] || changes[STORAGE_TOKEN_KEY])) {
    void reconfigureBridge();
  }
});

chrome.runtime.onStartup.addListener(() => {
  void ensureBridge();
  void registerCustomContentScripts();
});

// Access to a custom AI site is granted/revoked on the options page (needs a user click).
chrome.permissions.onAdded.addListener(() => {
  void registerCustomContentScripts({ injectOpenTabs: true });
});
chrome.permissions.onRemoved.addListener(() => {
  void registerCustomContentScripts();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const item = CONTEXT_MENU_ROLES[info.menuItemId];
  if (!item || !tab?.id) {
    return;
  }
  chrome.tabs
    .sendMessage(tab.id, { type: "webchat.pickElement", role: item.role }, { frameId: info.frameId ?? 0 })
    .catch(() => {
      // No content script here: the site isn't a built-in provider or an allowed custom AI site.
      void chrome.runtime.openOptionsPage();
    });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "webchat.bridge.reconnect") {
    void ensureBridge();
  }
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === "webchat.offscreen.ready") {
    void sendConnect();
    return false;
  }

  if (message?.type === "webchat.offscreen.status") {
    void chrome.storage.local.set({ [STORAGE_STATUS_KEY]: message.status });
    return false;
  }

  if (message?.type === "webchat.bridge.message") {
    void handleBridgeMessage(message.envelope);
    return false;
  }

  if (message?.type === "webchat.content.keepalive") {
    void ensureBridge();
    reportTabAlive(sender.tab);
    return false;
  }

  if (
    message?.type === "webchat.content.state" ||
    message?.type === "webchat.content.stream" ||
    message?.type === "webchat.content.done"
  ) {
    void sendToBridge({
      version: 1,
      id: crypto.randomUUID(),
      sessionId: SESSION_ID,
      type: message.bridgeType,
      createdAt: new Date().toISOString(),
      payload: {
        ...message.payload,
        tabId: sender.tab?.id,
        url: sender.tab?.url
      }
    });

    if (message?.type === "webchat.content.state" && message.payload?.state === "ready" && sender.tab?.id) {
      retryPendingPrompt(sender.tab.id);
    }
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  pendingPromptByTab.delete(tabId);
  lastTabAliveReport.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete" && pendingPromptByTab.has(tabId)) {
    const envelope = pendingPromptByTab.get(tabId);
    pendingPromptByTab.delete(tabId);
    void sendPromptToTab(tabId, envelope);
  }
});

void ensureBridge();

async function getBridgeConfig() {
  const stored = await chrome.storage.local.get([STORAGE_PORT_KEY, STORAGE_TOKEN_KEY]);
  const port = Number(stored[STORAGE_PORT_KEY]) || DEFAULT_BRIDGE_PORT;
  const token = typeof stored[STORAGE_TOKEN_KEY] === "string" ? stored[STORAGE_TOKEN_KEY].trim() : "";
  return { port, token };
}

async function ensureBridge() {
  await ensureOffscreenDocument();
  await sendConnect();
}

async function sendConnect() {
  const config = await getBridgeConfig();
  await chrome.runtime.sendMessage({ type: "webchat.bridge.connect", config }).catch(() => {});
}

async function reconfigureBridge() {
  await ensureOffscreenDocument();
  const config = await getBridgeConfig();
  await chrome.runtime.sendMessage({ type: "webchat.bridge.configure", config }).catch(() => {});
}

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);

  if (await hasOffscreenDocument(offscreenUrl)) {
    return;
  }

  if (creatingOffscreenDocument) {
    await creatingOffscreenDocument;
    return;
  }

  creatingOffscreenDocument = chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: ["WORKERS"],
    justification: "Keep the localhost WebSocket bridge alive for long-running WebChat agent sessions."
  });

  try {
    await creatingOffscreenDocument;
  } finally {
    creatingOffscreenDocument = undefined;
  }
}

async function hasOffscreenDocument(offscreenUrl) {
  if (chrome.offscreen.hasDocument) {
    return chrome.offscreen.hasDocument();
  }

  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [offscreenUrl]
  });

  return contexts.length > 0;
}

async function sendToBridge(envelope) {
  await ensureOffscreenDocument();
  await chrome.runtime.sendMessage({
    type: "webchat.bridge.send",
    envelope
  });
}

async function handleBridgeMessage(envelope) {
  if (envelope?.type === "providers.sync") {
    await storeCustomProviders(envelope.payload?.customProviders);
  } else if (envelope?.type === "chat.prompt") {
    await dispatchPrompt(envelope);
  } else if (envelope?.type === "chat.cancel") {
    await forwardToActiveTab({ type: "webchat.cancel", envelope });
  } else if (envelope?.type === "chat.model") {
    await forwardToActiveTab({ type: "webchat.model", model: envelope.payload?.model, envelope });
  } else if (envelope?.type === "chat.toggle") {
    await forwardToActiveTab({ type: "webchat.toggle", label: envelope.payload?.label, envelope });
  } else if (envelope?.type === "chat.navigate") {
    await navigateToChat(envelope.payload?.url);
  }
}

async function navigateToChat(url) {
  if (!url) {
    return;
  }
  const tabs = await queryProviderTabs();
  const activeTab = pickTabForUrl(tabs, url);

  if (activeTab?.id) {
    await chrome.tabs.update(activeTab.id, { url, active: true });
  } else {
    await chrome.tabs.create({ active: true, url });
  }
}

async function forwardToActiveTab(message) {
  const tabs = await queryProviderTabs();
  const activeTab = tabs.find((tab) => tab.active) || tabs[0];

  if (activeTab?.id) {
    try {
      await chrome.tabs.sendMessage(activeTab.id, message);
    } catch {
      // tab may be gone; nothing to do
    }
  }
}

async function dispatchPrompt(envelope) {
  const tabs = await queryProviderTabs();
  // Send to a tab of the provider the IDE targeted (matching host); open one only if none is open.
  const target = pickTabForUrl(tabs, envelope.payload.chatUrl);

  if (envelope.payload.expectedAction === "rotate") {
    // A fresh chat. Reuse the provider's tab (navigate it to a new conversation) instead of piling
    // up a new tab for every rotation.
    if (target?.id) {
      await startFreshChatInTab(target, envelope);
      return;
    }
  } else if (target?.id) {
    await sendPromptToTab(target.id, envelope);
    return;
  }

  const created = await chrome.tabs.create({
    active: true,
    url: envelope.payload.chatUrl
  });

  if (created.id) {
    pendingPromptByTab.set(created.id, envelope);
  }
}

async function startFreshChatInTab(tab, envelope) {
  const chatUrl = envelope.payload.chatUrl;

  // The prompt is sent by the onUpdated("complete") / content "ready" handlers once the new chat
  // page has loaded. Some sites keep the same URL for an ongoing conversation, so a same-URL tab
  // is reloaded rather than assumed to be a fresh chat.
  pendingPromptByTab.set(tab.id, envelope);
  if (sameUrl(tab.url, chatUrl)) {
    await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
    await chrome.tabs.reload(tab.id);
  } else {
    await chrome.tabs.update(tab.id, { url: chatUrl, active: true });
  }

  // Safety net: if the navigation never produced a "complete" event, deliver once the tab is idle.
  setTimeout(async () => {
    if (pendingPromptByTab.get(tab.id) !== envelope) {
      return;
    }
    const current = await chrome.tabs.get(tab.id).catch(() => undefined);
    if (current?.status === "complete") {
      void retryPendingPrompt(tab.id);
    }
  }, 5000);
}

function sameUrl(a, b) {
  try {
    const left = new URL(a);
    const right = new URL(b);
    const path = (url) => url.pathname.replace(/\/+$/, "") || "/";
    return left.origin === right.origin && path(left) === path(right) && left.search === right.search;
  } catch {
    return false;
  }
}

// Tell the IDE (at most every 10 s per tab) that this browser has a live provider tab, so prompts
// are routed to this browser rather than another paired one.
function reportTabAlive(tab) {
  if (!tab?.id) {
    return;
  }
  const now = Date.now();
  if (now - (lastTabAliveReport.get(tab.id) || 0) < 10000) {
    return;
  }
  lastTabAliveReport.set(tab.id, now);
  void sendToBridge({
    version: 1,
    id: crypto.randomUUID(),
    sessionId: SESSION_ID,
    type: "bridge.status",
    createdAt: new Date().toISOString(),
    payload: { state: "tab-alive", tabId: tab.id, url: tab.url }
  });
}

async function sendPromptToTab(tabId, envelope) {
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "webchat.prompt",
      envelope
    });
  } catch (error) {
    pendingPromptByTab.set(tabId, envelope);
    setTimeout(() => {
      void retryPendingPrompt(tabId);
    }, 1000);
    await sendToBridge({
      version: 1,
      id: crypto.randomUUID(),
      sessionId: SESSION_ID,
      type: "chat.error",
      createdAt: new Date().toISOString(),
      payload: {
        detail: error instanceof Error ? error.message : String(error),
        tabId
      }
    });
  }
}

async function retryPendingPrompt(tabId) {
  const envelope = pendingPromptByTab.get(tabId);

  if (!envelope) {
    return;
  }

  pendingPromptByTab.delete(tabId);
  await sendPromptToTab(tabId, envelope);
}

// ---- custom AI sites ------------------------------------------------------------------------------
async function getCustomProviders() {
  const stored = await chrome.storage.local.get(STORAGE_CUSTOM_KEY);
  return Array.isArray(stored[STORAGE_CUSTOM_KEY]) ? stored[STORAGE_CUSTOM_KEY] : [];
}

async function storeCustomProviders(list) {
  const cleaned = (Array.isArray(list) ? list : []).filter((entry) =>
    entry && typeof entry.host === "string" && typeof entry.matchPattern === "string" &&
    /^https?:\/\/[^/*]+\/\*$/.test(entry.matchPattern)
  );
  await chrome.storage.local.set({ [STORAGE_CUSTOM_KEY]: cleaned });
  await registerCustomContentScripts({ injectOpenTabs: true });
}

/** Match patterns of custom sites the user has granted access to. */
async function getGrantedCustomPatterns() {
  const granted = [];
  for (const entry of await getCustomProviders()) {
    if (await chrome.permissions.contains({ origins: [entry.matchPattern] }).catch(() => false)) {
      granted.push(entry.matchPattern);
    }
  }
  return [...new Set(granted)];
}

/**
 * Run content.js on every allowed custom site. Built-in providers use the static manifest entry;
 * custom ones are registered at runtime because their hosts are only known after the IDE syncs.
 */
async function registerCustomContentScripts(options = {}) {
  const patterns = await getGrantedCustomPatterns();
  await chrome.scripting.unregisterContentScripts({ ids: [CUSTOM_SCRIPT_ID] }).catch(() => {});
  if (patterns.length === 0) {
    return;
  }
  await chrome.scripting.registerContentScripts([{
    id: CUSTOM_SCRIPT_ID,
    matches: patterns,
    js: ["src/content.js"],
    runAt: "document_idle",
    persistAcrossSessions: true
  }]);

  if (options.injectOpenTabs) {
    // Tabs that were already open before access was granted don't get the script automatically.
    const tabs = await chrome.tabs.query({ url: patterns });
    for (const tab of tabs) {
      if (!tab.id) {
        continue;
      }
      const alive = await chrome.tabs.sendMessage(tab.id, { type: "webchat.ping" }).catch(() => undefined);
      if (!alive) {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["src/content.js"] }).catch(() => {});
      }
    }
  }
}

async function queryProviderTabs() {
  const patterns = [...PROVIDER_URL_PATTERNS, ...(await getGrantedCustomPatterns())];
  return chrome.tabs.query({ url: patterns });
}

/** Prefer a tab on the same host as `url` (active first); otherwise none, so a new tab opens. */
function pickTabForUrl(tabs, url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return tabs.find((tab) => tab.active) || tabs[0];
  }
  const sameHost = tabs.filter((tab) => {
    try {
      const tabHost = new URL(tab.url || "").hostname;
      return tabHost === host || tabHost.endsWith(`.${host}`) || host.endsWith(`.${tabHost}`);
    } catch {
      return false;
    }
  });
  return sameHost.find((tab) => tab.active) || sameHost[0];
}

function createContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: CONTEXT_MENU_ROOT, title: "WebChat Bridge", contexts: ["all"] });
    for (const [id, item] of Object.entries(CONTEXT_MENU_ROLES)) {
      chrome.contextMenus.create({ id, parentId: CONTEXT_MENU_ROOT, title: item.title, contexts: ["all"] });
    }
  });
}
