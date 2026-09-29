const SESSION_ID = "browser-extension";
const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const DEFAULT_BRIDGE_PORT = 53451;
// chrome.storage.local keys (written by options.html).
const STORAGE_PORT_KEY = "bridgePort";
const STORAGE_TOKEN_KEY = "bridgeToken";
const STORAGE_STATUS_KEY = "bridgeStatus";
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

chrome.runtime.onInstalled.addListener(async (details) => {
  void ensureBridge();
  chrome.alarms.create("webchat.bridge.reconnect", { periodInMinutes: 0.25 });
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
  if (envelope?.type === "chat.prompt") {
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
  const tabs = await chrome.tabs.query({ url: PROVIDER_URL_PATTERNS });
  const activeTab = tabs.find((tab) => tab.active) || tabs[0];

  if (activeTab?.id) {
    await chrome.tabs.update(activeTab.id, { url, active: true });
  } else {
    await chrome.tabs.create({ active: true, url });
  }
}

async function forwardToActiveTab(message) {
  const tabs = await chrome.tabs.query({ url: PROVIDER_URL_PATTERNS });
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
  const shouldOpenFreshChat = envelope.payload.expectedAction === "rotate";
  const tabs = shouldOpenFreshChat
    ? []
    : await chrome.tabs.query({ url: PROVIDER_URL_PATTERNS });
  const activeTab = tabs.find((tab) => tab.active) || tabs[0];

  if (activeTab?.id) {
    await sendPromptToTab(activeTab.id, envelope);
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
