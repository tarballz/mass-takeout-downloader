const detectedEl = document.getElementById("detected");
const rescanBtn = document.getElementById("rescan");
const concurrencyEl = document.getElementById("concurrency");
const concurrencyValueEl = document.getElementById("concurrency-value");
const startBtn = document.getElementById("start");
const retryBtn = document.getElementById("retry-failed");
const skipCompletedEl = document.getElementById("skip-completed");
const progressEl = document.getElementById("progress-summary");
const itemsEl = document.getElementById("items");
const authBannerEl = document.getElementById("auth-banner");

const CONCURRENCY_PREF_KEY = "concurrency";
const SKIP_COMPLETED_PREF_KEY = "skipCompleted";

const STATUS_ICON = {
  queued: "·",
  retrying: "⟲",
  active: "▶",
  complete: "✓",
  failed: "✗",
};

let links = [];
let completedMap = {}; // url -> saved filename
let running = false;
let port = null;

init();

async function init() {
  await loadPrefs();
  connectPort();
  await scanLinks();
}

async function loadPrefs() {
  const stored = await chrome.storage.local.get([
    CONCURRENCY_PREF_KEY,
    SKIP_COMPLETED_PREF_KEY,
  ]);
  const concurrency = stored[CONCURRENCY_PREF_KEY] ?? 3;
  concurrencyEl.value = String(concurrency);
  concurrencyValueEl.textContent = String(concurrency);
  skipCompletedEl.checked = stored[SKIP_COMPLETED_PREF_KEY] !== false;
}

concurrencyEl.addEventListener("input", () => {
  concurrencyValueEl.textContent = concurrencyEl.value;
  chrome.storage.local.set({ [CONCURRENCY_PREF_KEY]: Number(concurrencyEl.value) });
});

skipCompletedEl.addEventListener("change", () => {
  chrome.storage.local.set({ [SKIP_COMPLETED_PREF_KEY]: skipCompletedEl.checked });
  updateDetected();
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
      skipCompleted: skipCompletedEl.checked,
    });
  }
});

retryBtn.addEventListener("click", () => {
  port?.postMessage({ type: "RETRY_FAILED" });
});

function connectPort() {
  port = chrome.runtime.connect({ name: "popup" });
  port.onMessage.addListener(onPortMessage);
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
    completedMap = {};
    detectedEl.textContent = "Open takeout.google.com/manage to scan.";
    updateStartButton();
    return;
  }

  let response;
  try {
    response = await chrome.tabs.sendMessage(tab.id, { type: "SCAN_LINKS" });
  } catch (err) {
    links = [];
    completedMap = {};
    detectedEl.textContent = "Couldn't reach the page — try reloading it.";
    updateStartButton();
    return;
  }

  links = Array.isArray(response?.links) ? response.links : [];
  completedMap = {};
  updateDetected();
  updateStartButton();

  // Ask the SW to cross-reference scraped links against download history.
  if (links.length > 0) {
    port?.postMessage({ type: "CHECK_COMPLETED", links });
  }
}

function updateDetected() {
  const total = links.length;
  if (total === 0) {
    detectedEl.textContent = "No download links found on this page.";
    return;
  }
  const completedCount = Object.keys(completedMap).filter((u) =>
    links.some((l) => l.url === u),
  ).length;
  const parts = `${total} archive part${total === 1 ? "" : "s"} found`;
  if (completedCount === 0) {
    detectedEl.textContent = parts + ".";
    return;
  }
  const remaining = total - completedCount;
  const skip = skipCompletedEl.checked;
  const suffix = skip
    ? ` · ${completedCount} already downloaded, ${remaining} to go`
    : ` · ${completedCount} already downloaded (will re-download)`;
  detectedEl.textContent = parts + suffix;
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

function onPortMessage(msg) {
  if (msg?.type === "PROGRESS") {
    onProgress(msg);
    return;
  }
  if (msg?.type === "COMPLETED_INFO") {
    completedMap = msg.completed || {};
    updateDetected();
    return;
  }
}

function onProgress(msg) {
  running = !!msg.running;
  updateStartButton();

  authBannerEl.hidden = !msg.auth?.waiting;

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

    if (
      it.lastReason &&
      (it.status === "failed" || it.status === "retrying" || it.status === "complete")
    ) {
      const reason = document.createElement("span");
      reason.className = "reason";
      reason.textContent = it.lastReason;
      li.appendChild(reason);
    }

    itemsEl.appendChild(li);
  }
}
