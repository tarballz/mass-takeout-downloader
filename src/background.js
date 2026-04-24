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

const MAX_RETRIES = 6;
const BASE_BACKOFF_MS = 3000;
const MAX_BACKOFF_MS = 120_000;
const TAB_AUTH_TIMEOUT_MS = 90_000;
const STALL_WINDOW_TICKS = 3; // ~90s at 30s tick
const WATCHDOG_ALARM = "mtd_watchdog";
// Packed (non-developer) extensions clamp periodInMinutes to a minimum of 0.5
// (30s). Using 0.5 makes behavior identical in dev and prod.
const WATCHDOG_PERIOD_MIN = 0.5;
const STATE_KEY = "mtd_state";

const DOWNLOAD_URL_RE =
  /^https:\/\/(takeout-download\.usercontent\.google\.com|takeout\.google\.com\/takeout\/download)/;

const TRANSIENT_REASONS = new Set([
  "NETWORK_FAILED", "NETWORK_TIMEOUT", "NETWORK_DISCONNECTED",
  "NETWORK_SERVER_DOWN", "NETWORK_INVALID_REQUEST",
  "SERVER_FAILED", "SERVER_NO_RANGE", "SERVER_BAD_CONTENT",
  "SERVER_UNREACHABLE", "SERVER_CERT_PROBLEM",
  "FILE_FAILED", "FILE_TRANSIENT_ERROR", "FILE_VIRUS_INFECTED",
  "CRASH", "interrupted", "no download started", "stalled",
  "download record missing",
]);

const PERMANENT_REASONS = new Set([
  "SERVER_FORBIDDEN", "SERVER_UNAUTHORIZED",
  "FILE_NO_SPACE", "FILE_NAME_TOO_LONG", "FILE_ACCESS_DENIED",
  "FILE_TOO_SHORT", "FILE_TOO_LARGE", "FILE_SECURITY_CHECK_FAILED",
  "FILE_BLOCKED", "FILE_VIRUS_INFECTED_PERMANENT",
]);

const USER_CANCEL_REASONS = new Set(["USER_CANCELED", "USER_SHUTDOWN"]);

// state.items is the single source of truth; queued/active/failed are derived.
const state = {
  limit: 3,
  items: [],
  running: false,
};

let popupPort = null;
let restorePromise = null;

// --- popup connection ---

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "popup") return;
  popupPort = port;
  port.onDisconnect.addListener(() => {
    if (popupPort === port) popupPort = null;
  });
  port.onMessage.addListener((msg) => handlePopupMessage(msg, port));
  ensureRestored().then(() => broadcastProgress());
});

async function handlePopupMessage(msg, port) {
  await ensureRestored();
  switch (msg?.type) {
    case "START_DOWNLOADS":
      await startDownloads(msg.links, msg.concurrency);
      break;
    case "STOP_DOWNLOADS":
      await stopDownloads();
      break;
    case "RETRY_FAILED":
      await retryFailed();
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
  state.items = links.map((l, idx) => ({
    id: stableId(l.url, idx),
    url: l.url,
    filename: l.filename || null,
    label: l.label || l.filename || l.url,
    status: "queued",
    attempts: 0,
    lastReason: null,
    downloadId: null,
    tabId: null,
    tabDeadline: null,
    nextAttemptAt: 0,
    lastBytes: 0,
    stallTicks: 0,
  }));
  state.running = true;

  await ensureWatchdog();
  await persistState();
  pump();
  broadcastProgress();
}

async function stopDownloads() {
  state.running = false;

  const closures = [];
  for (const item of state.items) {
    if (item.status !== "active" && item.status !== "retrying") continue;
    // Null downloadId/tabId BEFORE issuing cancels so the resulting
    // onChanged/onRemoved events don't find a match and overwrite our status.
    const tabId = item.tabId;
    const downloadId = item.downloadId;
    item.tabId = null;
    item.downloadId = null;
    item.tabDeadline = null;
    item.status = "queued";
    if (tabId != null) closures.push(chrome.tabs.remove(tabId).catch(() => {}));
    if (downloadId != null) {
      closures.push(chrome.downloads.cancel(downloadId).catch(() => {}));
    }
  }
  await Promise.all(closures);
  await chrome.alarms.clear(WATCHDOG_ALARM);

  await persistState();
  broadcastProgress();
}

async function retryFailed() {
  let resurrected = 0;
  for (const item of state.items) {
    if (item.status === "failed") {
      item.status = "queued";
      item.attempts = 0;
      item.lastReason = null;
      item.nextAttemptAt = 0;
      resurrected += 1;
    }
  }
  if (resurrected === 0) return;
  state.running = true;
  await ensureWatchdog();
  await persistState();
  pump();
  broadcastProgress();
}

function activeCount() {
  let n = 0;
  for (const item of state.items) if (item.status === "active") n += 1;
  return n;
}

function readyQueue() {
  const now = Date.now();
  return state.items.filter(
    (it) =>
      it.status === "queued" ||
      (it.status === "retrying" && it.nextAttemptAt <= now),
  );
}

function pump() {
  if (!state.running) return;
  const ready = readyQueue();
  let slots = state.limit - activeCount();
  for (const item of ready) {
    if (slots <= 0) break;
    item.status = "active";
    slots -= 1;
    startOne(item);
  }
  // Are we fully done? (nothing active, nothing ready, nothing waiting to retry)
  const anyInFlight = state.items.some(
    (it) => it.status === "active" || it.status === "queued" || it.status === "retrying",
  );
  if (!anyInFlight) {
    state.running = false;
    persistState();
  }
}

async function startOne(item) {
  item.tabDeadline = Date.now() + TAB_AUTH_TIMEOUT_MS;
  item.downloadId = null;
  item.lastBytes = 0;
  item.stallTicks = 0;
  await persistState();
  broadcastProgress();

  let tab;
  try {
    tab = await chrome.tabs.create({ url: item.url, active: false });
  } catch (err) {
    // Guard against a stopDownloads() that flipped us out of "active" during
    // the await — don't stomp on the cleared state.
    if (item.status === "active") {
      await handleFailure(item, err?.message || String(err));
    }
    return;
  }
  if (item.status !== "active") {
    // Run was stopped mid-await. Close the zombie tab and bail.
    try { await chrome.tabs.remove(tab.id); } catch {}
    return;
  }
  item.tabId = tab.id;
  await persistState();
  broadcastProgress();
  // Tab-auth deadline is enforced by watchdogTick(), not setTimeout — so
  // service worker teardown can't orphan it.
}

async function handleFailure(item, reason) {
  item.lastReason = reason;
  item.downloadId = null;
  if (item.tabId != null) {
    const tabId = item.tabId;
    item.tabId = null;
    try { await chrome.tabs.remove(tabId); } catch {}
  }

  const klass = classifyReason(reason);
  if (klass === "transient" && item.attempts < MAX_RETRIES) {
    item.attempts += 1;
    item.status = "retrying";
    item.nextAttemptAt = Date.now() + backoffMs(item.attempts);
  } else {
    item.status = "failed";
  }

  await persistState();
  broadcastProgress();
  pump();
}

function classifyReason(reason) {
  if (!reason) return "transient";
  if (USER_CANCEL_REASONS.has(reason)) return "userCanceled";
  if (PERMANENT_REASONS.has(reason)) return "permanent";
  if (TRANSIENT_REASONS.has(reason)) return "transient";
  // Unknown reasons default to transient — better to retry once than silently drop.
  return "transient";
}

function backoffMs(attempt) {
  const base = Math.min(BASE_BACKOFF_MS * (2 ** (attempt - 1)), MAX_BACKOFF_MS);
  return base + Math.floor(Math.random() * 1500);
}

function stableId(url, idx) {
  // URL is unique per-part in practice, but fall back to index.
  return `${idx}:${url.slice(0, 120)}`;
}

// --- download event correlation ---

chrome.downloads.onCreated.addListener(async (dl) => {
  await ensureRestored();
  if (!DOWNLOAD_URL_RE.test(dl.url) && !DOWNLOAD_URL_RE.test(dl.finalUrl || "")) return;

  // Prefer URL-exact match: Chrome's DownloadItem.url is the pre-redirect URL,
  // which for Takeout matches our stored item.url byte-for-byte. Every part URL
  // is unique, so when this matches it's unambiguous — no tab-open-order race.
  let target = null;
  for (const item of state.items) {
    if (item.status !== "active") continue;
    if (item.tabId == null) continue;
    if (item.downloadId != null) continue;
    if (dl.url === item.url || dl.finalUrl === item.url) {
      target = item;
      break;
    }
  }
  // Fallback to oldest-unmatched: covers the case where Chrome's url field is
  // the post-redirect usercontent URL (differs by Chrome version and by
  // whether the 302 was followed internally).
  if (!target) {
    for (const item of state.items) {
      if (item.status !== "active") continue;
      if (item.tabId == null) continue;
      if (item.downloadId != null) continue;
      if (!target || (item.tabDeadline ?? 0) < (target.tabDeadline ?? 0)) {
        target = item;
      }
    }
  }
  if (!target) return;

  target.downloadId = dl.id;
  const tabId = target.tabId;
  target.tabId = null;
  await persistState();
  broadcastProgress();

  // Download is in flight; source tab is redundant. Chrome keeps downloading
  // after the tab closes.
  try { await chrome.tabs.remove(tabId); } catch {}
});

// User manually closed a spawned tab before a download started. Fail fast
// instead of waiting for the 90s tab-auth deadline.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await ensureRestored();
  const item = state.items.find((it) => it.tabId === tabId);
  if (!item) return;
  if (item.downloadId != null) return; // we closed it ourselves, expected
  item.tabId = null;
  await handleFailure(item, "tab closed before download started");
});

chrome.downloads.onChanged.addListener(async (delta) => {
  await ensureRestored();

  const item = state.items.find((it) => it.downloadId === delta.id);
  if (!item) return;

  if (delta.state?.current === "complete") {
    let info;
    try {
      info = (await chrome.downloads.search({ id: delta.id }))[0];
    } catch {}
    // Sanity: Takeout archive parts are zip/tar/gzip. If Chrome saved an HTML
    // body (session-expired interstitial with Content-Disposition, or similar)
    // that's a failed download dressed up as a success. Erase and retry.
    if (info?.mime === "text/html") {
      try { await chrome.downloads.removeFile(delta.id); } catch {}
      try { await chrome.downloads.erase({ id: delta.id }); } catch {}
      await handleFailure(item, "non-archive response (html)");
      return;
    }
    item.status = "complete";
    if (info?.filename) {
      const base = info.filename.split(/[\\/]/).pop();
      if (base) item.filename = base;
    }
    await persistState();
    broadcastProgress();
    pump();
    return;
  }

  if (delta.state?.current === "interrupted") {
    const reason = delta.error?.current || "interrupted";

    // Try to resume before counting it as a failure. FILE_FAILED and most
    // NETWORK_* reasons become resumable when Chrome retains the partial.
    // Skip the resume attempt for user cancels — those should fail fast.
    if (!USER_CANCEL_REASONS.has(reason)) {
      let info;
      try {
        info = (await chrome.downloads.search({ id: delta.id }))[0];
      } catch {}
      if (info?.canResume) {
        try {
          await chrome.downloads.resume(delta.id);
          return; // stay in active, no attempt bump
        } catch {}
      }
    }

    await handleFailure(item, reason);
  }
});

// --- watchdog ---

async function ensureWatchdog() {
  const existing = await chrome.alarms.get(WATCHDOG_ALARM);
  if (!existing) {
    chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: WATCHDOG_PERIOD_MIN });
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== WATCHDOG_ALARM) return;
  await ensureRestored();
  await watchdogTick();
});

async function watchdogTick() {
  const now = Date.now();
  let dirty = false;

  // 1. Reconcile active downloads + detect stalls.
  for (const item of state.items) {
    if (item.status !== "active" || item.downloadId == null) continue;
    let info;
    try {
      info = (await chrome.downloads.search({ id: item.downloadId }))[0];
    } catch { info = null; }

    if (!info) {
      await handleFailure(item, "download record missing");
      dirty = true;
      continue;
    }
    if (info.state === "interrupted") {
      const reason = info.error || "interrupted";
      if (info.canResume) {
        try {
          await chrome.downloads.resume(item.downloadId);
          continue;
        } catch {}
      }
      await handleFailure(item, reason);
      dirty = true;
      continue;
    }
    if (info.state === "in_progress") {
      const total = info.totalBytes || 0;
      const received = info.bytesReceived || 0;
      if (received > item.lastBytes) {
        item.lastBytes = received;
        item.stallTicks = 0;
        dirty = true;
      } else if (total > 0 && received < total) {
        item.stallTicks = (item.stallTicks || 0) + 1;
        dirty = true;
        if (item.stallTicks >= STALL_WINDOW_TICKS) {
          try { await chrome.downloads.cancel(item.downloadId); } catch {}
          await handleFailure(item, "stalled");
        }
      }
    }
  }

  // 2. Enforce tab-auth deadlines on tabs that never produced a download.
  // If the tab is still on a Google accounts page the user is typing a password
  // or confirming 2FA — extend once per tick instead of guillotining them.
  for (const item of state.items) {
    if (item.status !== "active") continue;
    if (item.downloadId != null) continue;
    if (item.tabDeadline == null) continue;
    if (now <= item.tabDeadline) continue;
    if (item.tabId != null) {
      let tabUrl = "";
      try {
        const tab = await chrome.tabs.get(item.tabId);
        tabUrl = tab.url || tab.pendingUrl || "";
      } catch {}
      if (tabUrl.startsWith("https://accounts.google.com/")) {
        item.tabDeadline = now + TAB_AUTH_TIMEOUT_MS;
        item.lastReason = "waiting for password";
        dirty = true;
        continue;
      }
    }
    await handleFailure(item, "no download started");
    dirty = true;
  }

  if (dirty) {
    await persistState();
    broadcastProgress();
  }
  // pump() is cheap and idempotent: it wakes retrying items whose backoff has
  // elapsed AND fills any open slots with queued items left over from a cold
  // start.
  if (state.running) pump();

  // 4. Shut off the alarm if nothing is in flight — saves wakeups.
  const anyInFlight = state.items.some(
    (it) => it.status === "active" || it.status === "queued" || it.status === "retrying",
  );
  if (!anyInFlight) {
    state.running = false;
    await persistState();
    await chrome.alarms.clear(WATCHDOG_ALARM);
  }
}

// --- progress wire ---

function broadcastProgress(port) {
  const totals = { done: 0, failed: 0, active: 0, queued: 0, retrying: 0 };
  for (const it of state.items) {
    if (it.status === "complete") totals.done += 1;
    else if (it.status === "failed") totals.failed += 1;
    else if (it.status === "active") totals.active += 1;
    else if (it.status === "queued") totals.queued += 1;
    else if (it.status === "retrying") totals.retrying += 1;
  }
  updateBadge(totals);
  const payload = {
    type: "PROGRESS",
    total: state.items.length,
    done: totals.done,
    failed: totals.failed,
    active: totals.active,
    queued: totals.queued + totals.retrying,
    retrying: totals.retrying,
    running: state.running,
    items: state.items.map((it) => ({
      id: it.id,
      label: it.filename || it.label,
      status: it.status,
      attempts: it.attempts,
      lastReason: it.lastReason,
    })),
  };
  const target = port || popupPort;
  if (target) {
    try { target.postMessage(payload); } catch {}
  }
}

function updateBadge(totals) {
  const total = state.items.length;
  const inFlight = totals.active + totals.queued + totals.retrying;
  try {
    if (total === 0) {
      chrome.action.setBadgeText({ text: "" });
      return;
    }
    if (inFlight > 0) {
      chrome.action.setBadgeText({ text: `${totals.done}/${total}` });
      chrome.action.setBadgeBackgroundColor({ color: "#1a73e8" });
    } else if (totals.failed > 0) {
      chrome.action.setBadgeText({ text: `${totals.failed}✗` });
      chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
    } else {
      chrome.action.setBadgeText({ text: "✓" });
      chrome.action.setBadgeBackgroundColor({ color: "#188038" });
    }
  } catch {}
}

function clampConcurrency(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 3;
  return Math.max(1, Math.min(5, Math.floor(v)));
}

// --- worker state persistence ---

// Coalesce concurrent persist calls: a watchdog tick can call persistState
// multiple times in a row; we only need the latest snapshot to land.
let persistInFlight = null;
let persistQueued = false;

async function persistState() {
  if (persistInFlight) {
    persistQueued = true;
    return persistInFlight;
  }
  persistInFlight = (async () => {
    try {
      await chrome.storage.session.set({
        [STATE_KEY]: {
          limit: state.limit,
          items: state.items,
          running: state.running,
        },
      });
    } finally {
      persistInFlight = null;
      if (persistQueued) {
        persistQueued = false;
        persistState();
      }
    }
  })();
  return persistInFlight;
}

async function restoreState() {
  const stored = (await chrome.storage.session.get(STATE_KEY))[STATE_KEY];
  if (!stored) return;
  state.limit = stored.limit ?? 3;
  state.items = Array.isArray(stored.items) ? stored.items : [];
  state.running = stored.running ?? false;
}

function ensureRestored() {
  if (!restorePromise) restorePromise = restoreState();
  return restorePromise;
}

// Wipe incompatible stored state on install/update so a state-shape change
// between versions can't blow up restoreState().
chrome.runtime.onInstalled.addListener(async () => {
  try {
    const stored = (await chrome.storage.session.get(STATE_KEY))[STATE_KEY];
    if (stored && !Array.isArray(stored.items)) {
      await chrome.storage.session.remove(STATE_KEY);
    }
  } catch {}
  try { await chrome.action.setBadgeText({ text: "" }); } catch {}
});

// Cold-start: restore state, and if a run was in flight, re-arm the watchdog
// and tick once so orphan tabs past their deadline get cleaned up immediately.
(async () => {
  await ensureRestored();
  const anyInFlight = state.items.some(
    (it) => it.status === "active" || it.status === "queued" || it.status === "retrying",
  );
  if (anyInFlight) {
    state.running = true;
    await ensureWatchdog();
    await watchdogTick();
  }
  broadcastProgress(); // refreshes the badge after a cold start
})();
