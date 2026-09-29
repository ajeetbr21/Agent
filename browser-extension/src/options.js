const DEFAULT_PORT = 53451;
const MIN_TOKEN_LENGTH = 24;
const LEGACY_TOKEN = "webchat-dev-token";

const STATUS_LABELS = {
  connected: "Connected to the IDE bridge",
  connecting: "Connecting…",
  disconnected: "Disconnected — reconnecting",
  unauthorized: "Token rejected by the IDE",
  offline: "IDE bridge not reachable",
  "no-token": "Not paired yet",
  unknown: "Status unknown"
};

const form = document.getElementById("pairing-form");
const tokenInput = document.getElementById("token");
const portInput = document.getElementById("port");
const toggleButton = document.getElementById("toggle-token");
const clearButton = document.getElementById("clear");
const message = document.getElementById("message");
const statusBox = document.getElementById("status");
const statusText = document.getElementById("status-text");

init();

async function init() {
  const stored = await chrome.storage.local.get(["bridgePort", "bridgeToken", "bridgeStatus"]);
  tokenInput.value = stored.bridgeToken || "";
  portInput.value = String(Number(stored.bridgePort) || DEFAULT_PORT);
  renderStatus(stored.bridgeStatus);
  // Ask the offscreen socket for a fresh status in case storage is stale.
  chrome.runtime.sendMessage({ type: "webchat.offscreen.statusRequest" }).catch(() => {});
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.bridgeStatus) {
    renderStatus(changes.bridgeStatus.newValue);
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const token = tokenInput.value.trim();
  const port = Number(portInput.value);

  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    showMessage("Port must be a whole number between 1024 and 65535.", "error");
    return;
  }
  if (token === LEGACY_TOKEN) {
    showMessage("That is the old public default token. Copy the real one from the IDE.", "error");
    return;
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    showMessage(`That doesn't look like a pairing token (expected at least ${MIN_TOKEN_LENGTH} characters).`, "error");
    return;
  }

  await chrome.storage.local.set({ bridgeToken: token, bridgePort: port });
  showMessage("Saved. Connecting…", "ok");
});

clearButton.addEventListener("click", async () => {
  await chrome.storage.local.remove("bridgeToken");
  tokenInput.value = "";
  showMessage("Token removed. The bridge is disconnected until you paste a new one.", "ok");
});

toggleButton.addEventListener("click", () => {
  const hidden = tokenInput.type === "password";
  tokenInput.type = hidden ? "text" : "password";
  toggleButton.textContent = hidden ? "Hide" : "Show";
});

function renderStatus(status) {
  const state = status?.state && STATUS_LABELS[status.state] ? status.state : "unknown";
  statusBox.dataset.state = state;
  statusText.textContent = status?.detail
    ? `${STATUS_LABELS[state]} — ${status.detail}`
    : STATUS_LABELS[state];
}

function showMessage(text, kind) {
  message.textContent = text;
  message.dataset.kind = kind;
}
