// Persistent WebSocket client for the IDE bridge (MV3 service workers can't hold sockets).
// Offscreen documents only get chrome.runtime, so the port + pairing token are pushed in by
// background.js (which reads them from chrome.storage.local, set on the options page).

const SESSION_ID = "browser-extension";
const RECONNECT_DELAY_MS = 1000;
const UNAUTHORIZED_RECONNECT_DELAY_MS = 5000;
const HEARTBEAT_MS = 5000;
const MAX_PENDING_ENVELOPES = 50;

let config = { port: 53451, token: "" };
let websocket;
let reconnectTimer;
let heartbeatTimer;
let pendingEnvelopes = [];
let lastStatus;

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "webchat.bridge.connect") {
    applyConfig(message.config, false);
    connectBridge();
    return false;
  }

  if (message?.type === "webchat.bridge.configure") {
    applyConfig(message.config, true);
    return false;
  }

  if (message?.type === "webchat.bridge.send") {
    sendToBridge(message.envelope);
    return false;
  }

  if (message?.type === "webchat.offscreen.statusRequest") {
    if (lastStatus) {
      publishStatus();
    }
    return false;
  }

  return false;
});

// Ask background.js for the port/token; it answers with webchat.bridge.connect.
chrome.runtime.sendMessage({ type: "webchat.offscreen.ready" });

function applyConfig(next, forceReconnect) {
  const port = Number(next?.port) || 53451;
  const token = typeof next?.token === "string" ? next.token.trim() : "";
  const changed = port !== config.port || token !== config.token;
  config = { port, token };

  if (changed || forceReconnect) {
    // Drop the old socket without triggering its reconnect handler, then dial with the new config.
    const old = websocket;
    websocket = undefined;
    clearInterval(heartbeatTimer);
    clearTimeout(reconnectTimer);
    if (old) {
      old.onclose = null;
      old.onerror = null;
      try { old.close(); } catch { /* already closed */ }
    }
    connectBridge();
  }
}

function connectBridge() {
  if (
    websocket?.readyState === WebSocket.OPEN ||
    websocket?.readyState === WebSocket.CONNECTING
  ) {
    return;
  }

  clearTimeout(reconnectTimer);

  if (!config.token) {
    reportStatus("no-token", "Paste the pairing token from the IDE into the extension options.");
    return; // background re-sends connect once a token is saved
  }

  reportStatus("connecting", `ws://127.0.0.1:${config.port}`);
  const socket = new WebSocket(`ws://127.0.0.1:${config.port}/?token=${encodeURIComponent(config.token)}`);
  websocket = socket;
  let opened = false;

  socket.onopen = () => {
    opened = true;
    reportStatus("connected", `ws://127.0.0.1:${config.port}`);
    sendToBridge({
      version: 1,
      id: crypto.randomUUID(),
      sessionId: SESSION_ID,
      type: "pair.request",
      createdAt: new Date().toISOString(),
      payload: {
        clientKind: "browser-extension",
        userAgent: navigator.userAgent,
        extensionVersion: getExtensionVersion()
      }
    });
    flushPendingEnvelopes();
    startHeartbeat();
  };

  socket.onmessage = (event) => {
    let envelope;
    try {
      envelope = JSON.parse(event.data);
    } catch {
      return;
    }
    chrome.runtime.sendMessage({ type: "webchat.bridge.message", envelope });
  };

  const onDown = () => {
    if (websocket !== socket) {
      return; // superseded by a reconfigure
    }
    socket.onclose = null;
    socket.onerror = null;
    websocket = undefined;
    clearInterval(heartbeatTimer);
    if (opened) {
      reportStatus("disconnected", "Bridge connection closed; reconnecting.");
      scheduleReconnect(RECONNECT_DELAY_MS);
    } else {
      void diagnoseFailedConnect();
    }
  };
  socket.onclose = onDown;
  socket.onerror = onDown;
}

// Browsers hide the HTTP status of a failed WebSocket upgrade, so ask /health whether the bridge is
// up at all and whether it accepts our token. That tells "IDE not running" from "wrong token".
async function diagnoseFailedConnect() {
  const { port, token } = config;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { "x-webchat-token": token },
      cache: "no-store"
    });
    const health = await response.json();
    if (health?.authenticated === true) {
      reportStatus("connecting", "Bridge reachable; retrying.");
      scheduleReconnect(RECONNECT_DELAY_MS);
    } else {
      reportStatus("unauthorized", "The IDE rejected this token. Copy it again with \"LeechCode: Copy Bridge Pairing Token\".");
      scheduleReconnect(UNAUTHORIZED_RECONNECT_DELAY_MS);
    }
  } catch {
    reportStatus("offline", `No bridge on 127.0.0.1:${port}. Is the IDE open with LeechCode running?`);
    scheduleReconnect(RECONNECT_DELAY_MS);
  }
}

function sendToBridge(envelope) {
  if (websocket?.readyState === WebSocket.OPEN) {
    websocket.send(JSON.stringify(envelope));
    return true;
  }

  pendingEnvelopes.push(envelope);
  if (pendingEnvelopes.length > MAX_PENDING_ENVELOPES) {
    pendingEnvelopes.shift();
  }
  connectBridge();
  return false;
}

function flushPendingEnvelopes() {
  const toSend = pendingEnvelopes;
  pendingEnvelopes = [];

  for (const envelope of toSend) {
    sendToBridge(envelope);
  }
}

function startHeartbeat() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    sendToBridge({
      version: 1,
      id: crypto.randomUUID(),
      sessionId: SESSION_ID,
      type: "bridge.status",
      createdAt: new Date().toISOString(),
      payload: {
        state: "alive",
        location: "offscreen"
      }
    });
  }, HEARTBEAT_MS);
}

function scheduleReconnect(delayMs) {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectBridge, delayMs);
}

function reportStatus(state, detail) {
  if (lastStatus?.state === state && lastStatus?.detail === detail) {
    return;
  }
  lastStatus = { state, detail, at: new Date().toISOString() };
  publishStatus();
}

function publishStatus() {
  chrome.runtime.sendMessage({ type: "webchat.offscreen.status", status: lastStatus }).catch(() => {});
}

function getExtensionVersion() {
  if (typeof chrome.runtime.getManifest === "function") {
    return chrome.runtime.getManifest().version;
  }

  return "unknown";
}
