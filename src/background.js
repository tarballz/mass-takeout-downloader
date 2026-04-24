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
const AUTH_GATE_TIMEOUT_MS = 5 * 60 * 1000; // user has 5 min to enter password
const STALL_WINDOW_TICKS = 3; // ~90s at 30s tick
const WATCHDOG_ALARM = "mtd_watchdog";
// Packed (non-developer) extensions clamp periodInMinutes to a minimum of 0.5
// (30s). Using 0.5 makes behavior identical in dev and prod.
const WATCHDOG_PERIOD_MIN = 0.5;
const STATE_KEY = "mtd_state";
const AUTH_URL_PREFIX = "https://accounts.google.com/";

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
// Auth gate: when a tab redirects to accounts.google.com we stop dispatching
// new tabs, close pending-auth siblings, and wait for the user to complete the
// password prompt. sessionProven flips true the first time a download actually
// starts, allowing full-concurrency dispatch.
const state = {
  limit: 3,
  items: [],
  running: false,
  sessionProven: false,
  authTabId: null,
  authItemId: null,
  authSince: null,
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
      await startDownloads(msg.links, msg.concurrency, {
        skipCompleted: !!msg.skipCompleted,
      });
      break;
    case "STOP_DOWNLOADS":
      await stopDownloads();
      break;
    case "RETRY_FAILED":
      await retryFailed();
      break;
    case "CHECK_COMPLETED":
      await handleCheckCompleted(msg.links, port);
      break;
    case "GET_STATE":
      broadcastProgress(port);
      break;
  }
}

// Keyed by (jobId, partId) so URL param ordering / host differences don't
// cause false misses. A Takeout download URL is unambiguously identified by
// j=<jobId>&i=<partId> — no other query params matter for equality.
function partKey(url) {
  try {
    const u = new URL(url);
    const j = u.searchParams.get("j");
    const i = u.searchParams.get("i");
    if (j && i) return `${j}:${i}`;
  } catch {}
  return null;
}

function basename(path) {
  if (!path) return "";
  return path.split(/[\\/]/).pop() || path;
}

// Query Chrome's download history for completed Takeout parts that still
// exist on disk, return a map of url -> saved-filename for the links we care
// about. One search is enough: Chrome filters server-side by query term, we
// filter the rest client-side.
async function findCompletedDownloads(links) {
  const completed = {};
  if (!Array.isArray(links) || links.length === 0) return completed;

  let results = [];
  try {
    results = await chrome.downloads.search({
      query: ["takeout"],
      state: "complete",
      limit: 0, // no cap — users with huge histories still match
    });
  } catch {
    return completed;
  }

  const byKey = new Map();
  for (const r of results) {
    if (r.exists === false) continue; // file was moved/deleted → don't skip
    const url = r.url || "";
    const finalUrl = r.finalUrl || "";
    if (!DOWNLOAD_URL_RE.test(url) && !DOWNLOAD_URL_RE.test(finalUrl)) continue;
    const key = partKey(url) || partKey(finalUrl);
    if (!key) continue;
    // search returns newest-first by default; first hit per key wins.
    if (!byKey.has(key)) byKey.set(key, r.filename);
  }

  for (const link of links) {
    const key = partKey(link.url);
    if (!key) continue;
    const filename = byKey.get(key);
    if (filename) completed[link.url] = basename(filename);
  }
  return completed;
}

async function handleCheckCompleted(links, port) {
  const completed = await findCompletedDownloads(links || []);
  const payload = { type: "COMPLETED_INFO", completed };
  const target = port || popupPort;
  if (target) {
    try { target.postMessage(payload); } catch {}
  }
}

// --- queue control ---

async function startDownloads(links, concurrency, options = {}) {
  if (state.running) return;
  if (!Array.isArray(links) || links.length === 0) return;

  // When skipCompleted is set, query download history and pre-mark items whose
  // file is already on disk as complete so the run only attempts the rest.
  // The completed items stay in state.items so the popup list shows the full
  // batch at a glance (with ✓ on the skipped ones).
  const completedMap = options.skipCompleted
    ? await findCompletedDownloads(links)
    : {};

  state.limit = clampConcurrency(concurrency);
  state.items = links.map((l, idx) => {
    const preCompletedName = completedMap[l.url] || null;
    return {
      id: stableId(l.url, idx),
      url: l.url,
      filename: preCompletedName || l.filename || null,
      label: l.label || l.filename || l.url,
      status: preCompletedName ? "complete" : "queued",
      attempts: 0,
      lastReason: preCompletedName ? "already downloaded" : null,
      downloadId: null,
      tabId: null,
      tabDeadline: null,
      nextAttemptAt: 0,
      lastBytes: 0,
      stallTicks: 0,
    };
  });
  const hasWork = state.items.some((it) => it.status === "queued");
  state.running = hasWork;
  state.sessionProven = false;
  state.authTabId = null;
  state.authItemId = null;
  state.authSince = null;

  if (hasWork) await ensureWatchdog();
  await persistState();
  if (hasWork) pump();
  broadcastProgress();
}

async function stopDownloads() {
  state.running = false;
  // Close any gated auth tab as part of the stop. authTabId is either in
  // state.items[*].tabId (if status===active) OR dangling if we flipped the
  // item back to queued; cover both cases explicitly.
  const gatedTabId = state.authTabId;
  state.authTabId = null;
  state.authItemId = null;
  state.authSince = null;
  state.sessionProven = false;
  if (gatedTabId != null) {
    try { await chrome.tabs.remove(gatedTabId); } catch {}
  }

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
  // Re-probe on retry: session may have expired between runs.
  state.sessionProven = false;
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

function effectiveConcurrency() {
  if (state.authTabId != null) return 0;   // auth gate closed: dispatch nothing
  if (!state.sessionProven) return 1;      // probing: serial until first download starts
  return state.limit;
}

function pump() {
  if (!state.running) return;
  const ready = readyQueue();
  let slots = effectiveConcurrency() - activeCount();
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

  // A download actually starting is the trusted signal that session is valid.
  // Close any open auth gate and flip sessionProven so pump() can go full
  // concurrency.
  const wasGated = state.authTabId === target.tabId;
  if (wasGated || !state.sessionProven) {
    state.authTabId = null;
    state.authItemId = null;
    state.authSince = null;
    state.sessionProven = true;
    for (const it of state.items) {
      if (
        it.lastReason === "queued behind auth" ||
        it.lastReason === "waiting for password confirmation"
      ) {
        it.lastReason = null;
      }
    }
  }
  await persistState();
  broadcastProgress();

  // DELIBERATELY don't close the tab here. onCreated fires as soon as Chrome
  // registers the download in its manager, BEFORE the download is fully
  // "adopted" by the downloads service. Closing the initiating tab at that
  // exact moment can race with adoption and cause Chrome to abort the
  // download, surfacing as an erroneous USER_CANCELED. Instead, the onChanged
  // handler closes the tab once real progress is observed (bytesReceived or a
  // state transition) — by that point the download is guaranteed live and
  // tab closure is safe.

  if (wasGated) pump(); // re-dispatch requeued items
});

// Tab-URL change is the PRIMARY detector for auth redirects: any spawned tab
// landing on accounts.google.com triggers the auth gate. tabs permission alone
// is enough to receive `changeInfo.url`; no host permission needed.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url) return;
  if (!changeInfo.url.startsWith(AUTH_URL_PREFIX)) return;
  await ensureRestored();
  const item = state.items.find((it) => it.tabId === tabId);
  if (!item) return;
  await handleAuthRedirect(item);
});

async function handleAuthRedirect(item) {
  // Gate already open on a DIFFERENT tab → this is a secondary auth-pending
  // tab. Close it and requeue the item so only one auth prompt is visible.
  if (state.authTabId != null && state.authTabId !== item.tabId) {
    const tabId = item.tabId;
    item.tabId = null;
    item.tabDeadline = null;
    item.status = "queued";
    item.lastReason = "queued behind auth";
    try { await chrome.tabs.remove(tabId); } catch {}
    await persistState();
    broadcastProgress();
    return;
  }
  // Gate already open on THIS tab → sub-navigation inside accounts.google.com
  // (2FA step, etc). No-op.
  if (state.authTabId === item.tabId) return;

  // Open the gate.
  state.authTabId = item.tabId;
  state.authItemId = item.id;
  state.authSince = Date.now();
  state.sessionProven = false;
  item.lastReason = "waiting for password confirmation";
  item.tabDeadline = null; // watchdog won't enforce deadline on gated tab

  // Close every other tab still waiting for a download to start; requeue.
  // Items whose download is already in flight (downloadId != null) are left
  // alone — those keep progressing independent of their source tab.
  const closures = [];
  for (const other of state.items) {
    if (other.id === item.id) continue;
    if (other.status !== "active") continue;
    if (other.tabId == null) continue;
    if (other.downloadId != null) continue;
    const tid = other.tabId;
    other.tabId = null;
    other.tabDeadline = null;
    other.status = "queued";
    other.lastReason = "queued behind auth";
    closures.push(chrome.tabs.remove(tid).catch(() => {}));
  }
  await Promise.all(closures);

  // Make the auth tab active + focus its window so the user can't miss it.
  try {
    await chrome.tabs.update(item.tabId, { active: true });
    const tab = await chrome.tabs.get(item.tabId);
    if (tab?.windowId != null) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
  } catch {}

  await persistState();
  broadcastProgress();
}

// User manually closed a spawned tab. The auth-tab branch is first so we can
// treat it as an explicit cancel (halt the run); other tab closures fail the
// item fast instead of waiting 90s.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await ensureRestored();

  if (state.authTabId === tabId) {
    const item = state.items.find((it) => it.id === state.authItemId);
    state.authTabId = null;
    state.authItemId = null;
    state.authSince = null;
    state.running = false;
    if (item) {
      item.tabId = null;
      item.tabDeadline = null;
      item.status = "queued";
      item.lastReason = "auth cancelled";
    }
    try { await chrome.alarms.clear(WATCHDOG_ALARM); } catch {}
    await persistState();
    broadcastProgress();
    return;
  }

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

  // Close the initiating tab the first time Chrome reports real progress or a
  // state change for this download. At this point Chrome has fully adopted
  // the download, so closing the tab can't cancel it. See onCreated comment
  // for why we delay instead of closing there.
  if (
    item.tabId != null &&
    (delta.bytesReceived != null ||
      delta.state?.current === "in_progress" ||
      delta.state?.current === "complete" ||
      delta.state?.current === "interrupted")
  ) {
    const tabId = item.tabId;
    item.tabId = null;
    chrome.tabs.remove(tabId).catch(() => {});
  }

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

  // 0. Enforce auth-gate timeout. If the user walks away without entering
  // their password, close the auth tab and fail that item so the run can
  // proceed (the next item will likely re-trigger the gate).
  if (state.authTabId != null && state.authSince != null) {
    if (now - state.authSince > AUTH_GATE_TIMEOUT_MS) {
      const item = state.items.find((it) => it.id === state.authItemId);
      const gatedTab = state.authTabId;
      state.authTabId = null;
      state.authItemId = null;
      state.authSince = null;
      try { await chrome.tabs.remove(gatedTab); } catch {}
      if (item) await handleFailure(item, "auth timed out");
      dirty = true;
    }
  }

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
      } else if (received > 0 && total > 0 && received < total && !info.paused) {
        // Only count as stalled if the download has actually started
        // receiving bytes. A download with bytesReceived === 0 may be queued
        // by Chrome behind others (per-host connection limit is 6), and
        // could legitimately sit at 0 for a while before getting its turn —
        // don't cancel it.
        item.stallTicks = (item.stallTicks || 0) + 1;
        dirty = true;
        if (item.stallTicks >= STALL_WINDOW_TICKS) {
          // Null downloadId BEFORE canceling so the resulting onChanged
          // USER_CANCELED event can't race against our handleFailure call
          // and overwrite "stalled" with "USER_CANCELED" / permanent-failed.
          const downloadId = item.downloadId;
          item.downloadId = null;
          try { await chrome.downloads.cancel(downloadId); } catch {}
          await handleFailure(item, "stalled");
        }
      }
    }
  }

  // 2. Enforce tab-auth deadlines on tabs that never produced a download.
  // Safety net: if tabs.onUpdated missed the accounts.google.com redirect and
  // the tab is sitting there when the deadline elapses, hand off to the auth
  // gate instead of killing the tab.
  for (const item of state.items) {
    if (item.status !== "active") continue;
    if (item.downloadId != null) continue;
    if (item.tabDeadline == null) continue; // gated tab has null deadline
    if (now <= item.tabDeadline) continue;
    if (item.tabId === state.authTabId) continue; // defensive
    if (item.tabId != null) {
      let tabUrl = "";
      try {
        const tab = await chrome.tabs.get(item.tabId);
        tabUrl = tab.url || tab.pendingUrl || "";
      } catch {}
      if (tabUrl.startsWith(AUTH_URL_PREFIX)) {
        await handleAuthRedirect(item);
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
    auth:
      state.authTabId != null
        ? { waiting: true, sinceMs: Date.now() - (state.authSince ?? Date.now()) }
        : null,
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
          sessionProven: state.sessionProven,
          authTabId: state.authTabId,
          authItemId: state.authItemId,
          authSince: state.authSince,
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
  state.sessionProven = stored.sessionProven ?? false;
  state.authTabId = stored.authTabId ?? null;
  state.authItemId = stored.authItemId ?? null;
  state.authSince = stored.authSince ?? null;
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
