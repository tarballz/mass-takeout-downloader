# Mass Takeout Downloader

Chrome (MV3) extension that downloads all parts of a Google Takeout export in one click, with bounded concurrency.

Google Takeout splits big exports into many archive parts (50+ is common) and makes you click Download on each one, with an occasional password re-prompt. This extension scrapes the links from the Takeout manage-exports page and hands them off to the browser's download flow N at a time.

## Install (unpacked)

```bash
git clone https://github.com/tarballz/mass-takeout-downloader.git
cd mass-takeout-downloader
uv run --with pillow python scripts/make_icons.py   # generate toolbar icons
```

Then:

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and pick the repo folder
4. Pin the extension to your toolbar

## Use

1. Open your Takeout exports at <https://takeout.google.com/manage>
2. Click the extension icon — the popup shows how many archive parts it detected
3. Pick concurrency (1–5, default 3) and click **Start**
4. Files land in your default Chrome downloads folder

Click **Stop** to cancel in-flight downloads and drain the queue.

**First run / password prompts**: each archive part opens briefly in a background tab. If Google wants you to confirm your password, one of those tabs will show the prompt — enter your password there and the rest of the queue should go through without prompting, since the session cookie carries across.

## How it works

- `src/content.js` scrapes anchors on `takeout.google.com/manage*` whose href points at `takeout.google.com/takeout/download?j=...&i=...` (each one is a Takeout archive part).
- `src/popup.js` gathers those links and hands them to the service worker, then renders per-item status.
- `src/background.js` runs a concurrency-bounded pool: for each item it opens the URL in an inactive `chrome.tabs.create` tab. If the tab receives a file response, Chrome starts the download; the extension correlates the new download back to the source item by URL-exact match on `DownloadItem.url` (falling back to oldest-unmatched tab if the redirect already collapsed). A `chrome.alarms` watchdog ticks every 30s to reconcile active downloads against `chrome.downloads.search`, enforce the tab-auth deadline (extending it automatically if the tab is still on `accounts.google.com`), detect stalled downloads (no bytes received for ~90s), and wake items whose retry backoff has elapsed. `chrome.tabs.onRemoved` fails an item fast if the user manually closes its background tab.

Why tabs instead of `chrome.downloads.download`: the `/takeout/download?...` URL returns either a 302 to the signed file URL OR an HTML password-confirmation page. `chrome.downloads.download` saves whatever it gets, so an HTML response becomes a `pwd.htm` file on disk. Navigating a tab to the same URL lets the browser do the right thing with each content-type.

## Notes

- Takeout signed URLs expire after ~1 week. If downloads fail with `SERVER_FORBIDDEN`/`SERVER_UNAUTHORIZED`, the export itself has expired — regenerate it from Takeout.
- Transient failures (`NETWORK_*`, `SERVER_FAILED`, `FILE_FAILED`, `CRASH`, stalls, auth-timeouts) retry up to 6 times with exponential backoff (3s → 6s → 12s → 24s → 48s → 96s, +jitter, capped at 2 min). Permanent failures (403/401, disk full, name too long) skip retries.
- When Chrome marks an interrupted download as resumable, the extension calls `chrome.downloads.resume()` instead of restarting from zero — FILE_FAILED partway through a multi-GB part is almost always recoverable.
- Downloads that "complete" with `text/html` mime are recognized as garbage (e.g. a session-expired interstitial with `Content-Disposition: attachment`), erased, and retried instead of claiming success.
- A "Retry failed" button in the popup re-enqueues any items that gave up, without rescanning the page. The toolbar badge shows `done/total` while downloading, `N✗` on failures, and `✓` when a batch finishes cleanly — so you don't have to leave the popup open to know the run is making progress.
- Worker state (including per-item attempt counters and tab deadlines) persists in `chrome.storage.session`. The `chrome.alarms` watchdog survives service-worker teardown, so tabs can't be orphaned if the SW is killed mid-run.

## File layout

```
manifest.json
src/
  background.js    # queue + tab-driven downloads
  content.js       # scrapes anchors on the Takeout page
  popup.html
  popup.js
  popup.css
scripts/
  make_icons.py    # regenerate the three toolbar PNGs
icons/             # generated, .gitignored
  icon{16,48,128}.png
```

## License

MIT
