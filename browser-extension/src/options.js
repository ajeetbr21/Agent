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
const customList = document.getElementById("custom-list");
const overrideList = document.getElementById("override-list");

init();

async function init() {
  const stored = await chrome.storage.local.get(["bridgePort", "bridgeToken", "bridgeStatus"]);
  tokenInput.value = stored.bridgeToken || "";
  portInput.value = String(Number(stored.bridgePort) || DEFAULT_PORT);
  renderStatus(stored.bridgeStatus);
  await renderCustomProviders();
  // Ask the offscreen socket for a fresh status in case storage is stale.
  chrome.runtime.sendMessage({ type: "webchat.offscreen.statusRequest" }).catch(() => {});
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.bridgeStatus) {
    renderStatus(changes.bridgeStatus.newValue);
  }
  if (area === "local" && (changes.customProviders || changes.selectorOverrides)) {
    void renderCustomProviders();
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

// ---- custom AI sites ------------------------------------------------------------------------------

chrome.permissions.onAdded.addListener(() => void renderCustomProviders());
chrome.permissions.onRemoved.addListener(() => void renderCustomProviders());

async function renderCustomProviders() {
  const { customProviders = [], selectorOverrides = {} } =
    await chrome.storage.local.get(["customProviders", "selectorOverrides"]);

  customList.replaceChildren();
  if (customProviders.length === 0) {
    customList.append(listItem("None yet — add one in the editor (⚙ Settings → Custom AI sites) while this browser is connected."));
  }
  for (const site of customProviders) {
    const granted = await chrome.permissions.contains({ origins: [site.matchPattern] });
    const item = listItem(`${site.label} — ${site.host}`);
    const badge = document.createElement("span");
    badge.className = granted ? "badge ok" : "badge warn";
    badge.textContent = granted ? "allowed" : "needs access";
    item.append(badge);

    const button = document.createElement("button");
    button.type = "button";
    button.className = granted ? "secondary" : "";
    button.textContent = granted ? "Revoke" : "Allow";
    button.addEventListener("click", async () => {
      // permissions.request must run directly inside a user gesture.
      if (granted) {
        await chrome.permissions.remove({ origins: [site.matchPattern] });
      } else {
        const ok = await chrome.permissions.request({ origins: [site.matchPattern] });
        showMessage(ok ? `Access granted for ${site.host}. Open or reload its tab.` : "Access was not granted.", ok ? "ok" : "error");
      }
      await renderCustomProviders();
    });
    item.append(button);
    customList.append(item);
  }

  overrideList.replaceChildren();
  for (const [host, picks] of Object.entries(selectorOverrides)) {
    const roles = Object.entries(picks).filter(([, selector]) => selector);
    if (roles.length === 0) {
      continue;
    }
    const item = listItem(`${host}: ${roles.map(([role, selector]) => `${role} → ${selector}`).join(" · ")}`);
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "secondary";
    reset.textContent = "Reset";
    reset.addEventListener("click", async () => {
      const { selectorOverrides: all = {} } = await chrome.storage.local.get("selectorOverrides");
      delete all[host];
      await chrome.storage.local.set({ selectorOverrides: all });
    });
    item.append(reset);
    overrideList.append(item);
  }
}

function listItem(text) {
  const item = document.createElement("li");
  const label = document.createElement("span");
  label.className = "custom-label";
  label.textContent = text;
  item.append(label);
  return item;
}
