const detectedEl = document.getElementById("detected");
const rescanBtn = document.getElementById("rescan");
const concurrencyEl = document.getElementById("concurrency");
const concurrencyValueEl = document.getElementById("concurrency-value");
const startBtn = document.getElementById("start");
const progressEl = document.getElementById("progress-summary");
const recentEl = document.getElementById("recent");

const CONCURRENCY_PREF_KEY = "concurrency";

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
    progressEl.textContent =
      `${msg.done} / ${msg.total} done, ${msg.failed} failed, ${msg.active} active, ${msg.queued} queued`;
  }

  renderRecent(msg.recent || []);
}

function renderRecent(events) {
  recentEl.replaceChildren();
  for (const ev of events) {
    const li = document.createElement("li");

    const icon = document.createElement("span");
    icon.textContent = ev.status === "complete" ? "✓" : "✗";
    icon.className = ev.status === "complete" ? "status-complete" : "status-failed";
    li.appendChild(icon);

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = ev.filename;
    li.appendChild(name);

    if (ev.reason) {
      const reason = document.createElement("span");
      reason.className = "reason";
      reason.textContent = ev.reason;
      li.appendChild(reason);
    }

    recentEl.appendChild(li);
  }
}
