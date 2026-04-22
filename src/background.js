// Service worker: concurrency-bounded Takeout archive-part downloader.
//
// Why tabs instead of chrome.downloads.download:
// Google's /takeout/download?j=X&i=Y URL either streams the file (via a 302
// to the signed usercontent URL with Content-Disposition) OR returns an HTML
// password-confirmation page. chrome.downloads.download saves the response
// body regardless of content-type, so an HTML response becomes a pwd.htm file
// on disk. Navigating a tab to the same URL follows the browser's normal
// content-type handling: HTML renders as a page, attachment responses trigger
// downloads. The moment a download starts, the source tab is redundant and we
// close it; downloads continue independently of the tab that spawned them.

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 3000;
const TAB_AUTH_TIMEOUT_MS = 90_000; // give user time to enter password in tab
const RECENT_EVENT_LIMIT = 20;
const STATE_KEY = "mtd_state";

const DOWNLOAD_URL_RE =
  /^https:\/\/(takeout-download\.usercontent\.google\.com|takeout\.google\.com\/takeout\/download)/;

const state = {
  limit: 3,
  queue: [],          // pending: {url, filename?, label, attempts}
  active: new Map(),  // tabId -> {item, tabId, openedAt, downloadId | null}
  total: 0,
  done: 0,
  failed: 0,
  recent: [],
  running: false,
};

let popupPort = null;

// --- popup connection ---

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "popup") return;
  popupPort = port;
  port.onDisconnect.addListener(() => {
    if (popupPort === port) popupPort = null;
  });
  port.onMessage.addListener((msg) => handlePopupMessage(msg, port));
  broadcastProgress();
});

async function handlePopupMessage(msg, port) {
  switch (msg?.type) {
    case "START_DOWNLOADS":
      await startDownloads(msg.links, msg.concurrency);
      break;
    case "STOP_DOWNLOADS":
      await stopDownloads();
      break;
    case "GET_STATE":
      broadcastProgress(port);
      break;
  }
}

// --- queue control ---

async function startDownloads(links, concurrency) {
  if (state.running) return;
  if (!Array.isArray(links) || links.length === 0) return;

  state.limit = clampConcurrency(concurrency);
  state.queue = links.map((l) => ({
    url: l.url,
    filename: l.filename || null,
    label: l.label || l.filename || l.url,
    attempts: 0,
  }));
  state.active = new Map();
  state.total = links.length;
  state.done = 0;
  state.failed = 0;
  state.recent = [];
  state.running = true;

  await persistState();
  pump();
  broadcastProgress();
}

async function stopDownloads() {
  state.running = false;
  state.queue = [];

  const closures = [];
  for (const [tabId, entry] of state.active.entries()) {
    closures.push(chrome.tabs.remove(tabId).catch(() => {}));
    if (entry.downloadId != null) {
      closures.push(chrome.downloads.cancel(entry.downloadId).catch(() => {}));
    }
  }
  await Promise.all(closures);
  state.active = new Map();

  await persistState();
  broadcastProgress();
}

function pump() {
  if (!state.running) return;
  while (state.active.size < state.limit && state.queue.length > 0) {
    const item = state.queue.shift();
    startOne(item);
  }
  if (state.active.size === 0 && state.queue.length === 0) {
    state.running = false;
    persistState();
  }
}

async function startOne(item) {
  // Reserve the concurrency slot synchronously so a fast pump() loop can't
  // over-dispatch while tabs.create() is in flight.
  const slotKey = `slot:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const entry = { item, tabId: null, openedAt: Date.now(), downloadId: null, pending: true };
  state.active.set(slotKey, entry);
  await persistState();
  broadcastProgress();

  let tab;
  try {
    tab = await chrome.tabs.create({ url: item.url, active: false });
  } catch (err) {
    state.active.delete(slotKey);
    handleFailure(item, err?.message || String(err));
    await persistState();
    broadcastProgress();
    pump();
    return;
  }

  // Rekey the slot under the real tab id now that we have one.
  state.active.delete(slotKey);
  entry.tabId = tab.id;
  entry.pending = false;
  state.active.set(tab.id, entry);
  await persistState();
  broadcastProgress();

  // If no download hooks in within the timeout, assume password prompt or auth
  // failure, close the tab, and retry/fail the item.
  setTimeout(async () => {
    const current = state.active.get(tab.id);
    if (!current || current.downloadId != null) return;

    state.active.delete(tab.id);
    try { await chrome.tabs.remove(tab.id); } catch {}
    handleFailure(
      item,
      "no download started — click any Download button on the page once to confirm your password, then retry",
    );
    await persistState();
    broadcastProgress();
    pump();
  }, TAB_AUTH_TIMEOUT_MS);
}

function handleFailure(item, reason) {
  if (item.attempts < MAX_RETRIES) {
    item.attempts += 1;
    setTimeout(() => {
      if (!state.running) return;
      state.queue.unshift(item);
      pump();
      broadcastProgress();
    }, RETRY_DELAY_MS);
    return;
  }
  state.failed += 1;
  pushRecent({ filename: item.label, status: "failed", reason });
}

function pushRecent(event) {
  state.recent.unshift(event);
  if (state.recent.length > RECENT_EVENT_LIMIT) {
    state.recent.length = RECENT_EVENT_LIMIT;
  }
}

// --- download event correlation ---

chrome.downloads.onCreated.addListener(async (dl) => {
  if (state.active.size === 0) await restoreState();
  if (!DOWNLOAD_URL_RE.test(dl.url) && !DOWNLOAD_URL_RE.test(dl.finalUrl || "")) return;

  // Match to the oldest active tab that hasn't been paired with a download yet.
  // Skip pending entries — they don't have a real tab yet.
  let oldestKey = null;
  let oldestEntry = null;
  for (const [tabId, entry] of state.active.entries()) {
    if (entry.pending) continue;
    if (entry.downloadId != null) continue;
    if (!oldestEntry || entry.openedAt < oldestEntry.openedAt) {
      oldestKey = tabId;
      oldestEntry = entry;
    }
  }
  if (!oldestEntry) return;

  oldestEntry.downloadId = dl.id;
  await persistState();
  broadcastProgress();

  // Download is in flight; the source tab is no longer needed. Chrome keeps the
  // download running after the tab closes.
  try { await chrome.tabs.remove(oldestKey); } catch {}
});

chrome.downloads.onChanged.addListener(async (delta) => {
  if (state.active.size === 0) await restoreState();

  let foundTabId = null;
  let foundEntry = null;
  for (const [tabId, entry] of state.active.entries()) {
    if (entry.downloadId === delta.id) {
      foundTabId = tabId;
      foundEntry = entry;
      break;
    }
  }
  if (!foundEntry) return;

  if (delta.state?.current === "complete") {
    state.active.delete(foundTabId);
    state.done += 1;

    let info;
    try {
      info = (await chrome.downloads.search({ id: delta.id }))[0];
    } catch {}
    const filename = info?.filename?.split(/[\\/]/).pop() || foundEntry.item.label;
    pushRecent({ filename, status: "complete" });

    await persistState();
    broadcastProgress();
    pump();
  } else if (delta.state?.current === "interrupted") {
    state.active.delete(foundTabId);
    const reason = delta.error?.current || "interrupted";
    if (reason !== "USER_CANCELED") {
      handleFailure(foundEntry.item, reason);
    }
    await persistState();
    broadcastProgress();
    pump();
  }
});

// --- progress wire ---

function broadcastProgress(port) {
  const payload = {
    type: "PROGRESS",
    total: state.total,
    done: state.done,
    failed: state.failed,
    active: state.active.size,
    queued: state.queue.length,
    running: state.running,
    recent: state.recent.slice(0, 10),
  };
  const target = port || popupPort;
  if (target) {
    try { target.postMessage(payload); } catch {}
  }
}

function clampConcurrency(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 3;
  return Math.max(1, Math.min(5, Math.floor(v)));
}

// --- worker state persistence ---

async function persistState() {
  await chrome.storage.session.set({
    [STATE_KEY]: {
      limit: state.limit,
      queue: state.queue,
      active: Array.from(state.active.entries()),
      total: state.total,
      done: state.done,
      failed: state.failed,
      recent: state.recent,
      running: state.running,
    },
  });
}

async function restoreState() {
  const stored = (await chrome.storage.session.get(STATE_KEY))[STATE_KEY];
  if (!stored) return;
  state.limit = stored.limit ?? 3;
  state.queue = stored.queue ?? [];
  state.active = new Map(stored.active ?? []);
  state.total = stored.total ?? 0;
  state.done = stored.done ?? 0;
  state.failed = stored.failed ?? 0;
  state.recent = stored.recent ?? [];
  state.running = stored.running ?? false;
}

restoreState();
