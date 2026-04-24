const detectedEl = document.getElementById("detected");
const rescanBtn = document.getElementById("rescan");
const concurrencyEl = document.getElementById("concurrency");
const concurrencyValueEl = document.getElementById("concurrency-value");
const startBtn = document.getElementById("start");
const retryBtn = document.getElementById("retry-failed");
const progressEl = document.getElementById("progress-summary");
const itemsEl = document.getElementById("items");

const CONCURRENCY_PREF_KEY = "concurrency";

const STATUS_ICON = {
  queued: "·",
  retrying: "⟲",
  active: "▶",
  complete: "✓",
  failed: "✗",
};

let links = [];
let running = false;
let port = null;

init();

async function init() {
  await loadConcurrencyPref();
  connectPort();
  await scanLinks();
}

async function loadConcurrencyPref() {
  const stored = await chrome.storage.local.get(CONCURRENCY_PREF_KEY);
  const value = stored[CONCURRENCY_PREF_KEY] ?? 3;
  concurrencyEl.value = String(value);
  concurrencyValueEl.textContent = String(value);
}

concurrencyEl.addEventListener("input", () => {
  concurrencyValueEl.textContent = concurrencyEl.value;
  chrome.storage.local.set({ [CONCURRENCY_PREF_KEY]: Number(concurrencyEl.value) });
});

rescanBtn.addEventListener("click", scanLinks);

startBtn.addEventListener("click", () => {
  if (running) {
    port?.postMessage({ type: "STOP_DOWNLOADS" });
  } else {
    if (links.length === 0) return;
    port?.postMessage({
      type: "START_DOWNLOADS",
      links,
      concurrency: Number(concurrencyEl.value),
    });
  }
});

retryBtn.addEventListener("click", () => {
  port?.postMessage({ type: "RETRY_FAILED" });
});

function connectPort() {
  port = chrome.runtime.connect({ name: "popup" });
  port.onMessage.addListener(onProgress);
  port.onDisconnect.addListener(() => {
    port = null;
  });
  port.postMessage({ type: "GET_STATE" });
}

async function scanLinks() {
  detectedEl.textContent = "Scanning…";
  startBtn.disabled = true;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const onTakeout =
    tab?.url?.startsWith("https://takeout.google.com/manage") ||
    tab?.url?.startsWith("https://takeout.google.com/settings/takeout/downloads");
  if (!onTakeout) {
    links = [];
    detectedEl.textContent = "Open takeout.google.com/manage to scan.";
    updateStartButton();
    return;
  }

  let response;
  try {
    response = await chrome.tabs.sendMessage(tab.id, { type: "SCAN_LINKS" });
  } catch (err) {
    links = [];
    detectedEl.textContent = "Couldn't reach the page — try reloading it.";
    updateStartButton();
    return;
  }

  links = Array.isArray(response?.links) ? response.links : [];
  detectedEl.textContent =
    links.length === 0
      ? "No download links found on this page."
      : `${links.length} archive part${links.length === 1 ? "" : "s"} found.`;
  updateStartButton();
}

function updateStartButton() {
  if (running) {
    startBtn.disabled = false;
    startBtn.textContent = "Stop";
    startBtn.classList.add("running");
  } else {
    startBtn.disabled = links.length === 0;
    startBtn.textContent = "Start";
    startBtn.classList.remove("running");
  }
}

function onProgress(msg) {
  if (msg?.type !== "PROGRESS") return;

  running = !!msg.running;
  updateStartButton();

  if (msg.total === 0) {
    progressEl.textContent = "Idle";
  } else {
    const retryingSuffix = msg.retrying ? `, ${msg.retrying} retrying` : "";
    progressEl.textContent =
      `${msg.done} / ${msg.total} done, ${msg.failed} failed, ${msg.active} active, ${msg.queued} queued${retryingSuffix}`;
  }

  if (msg.failed > 0) {
    retryBtn.hidden = false;
    retryBtn.textContent = `Retry failed (${msg.failed})`;
    retryBtn.disabled = running;
  } else {
    retryBtn.hidden = true;
  }

  renderItems(msg.items || []);
}

function renderItems(items) {
  itemsEl.replaceChildren();
  for (const it of items) {
    const li = document.createElement("li");
    li.className = `status-${it.status}`;

    const icon = document.createElement("span");
    icon.className = "icon";
    icon.textContent = STATUS_ICON[it.status] ?? "?";
    li.appendChild(icon);

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = it.label;
    li.appendChild(name);

    if (it.attempts > 0 && it.status !== "complete") {
      const attempts = document.createElement("span");
      attempts.className = "attempts";
      attempts.textContent = `×${it.attempts}`;
      li.appendChild(attempts);
    }

    if (it.lastReason && (it.status === "failed" || it.status === "retrying")) {
      const reason = document.createElement("span");
      reason.className = "reason";
      reason.textContent = it.lastReason;
      li.appendChild(reason);
    }

    itemsEl.appendChild(li);
  }
}
