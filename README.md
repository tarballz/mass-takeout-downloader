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
- `src/popup.js` gathers those links and hands them to the service worker.
- `src/background.js` runs a concurrency-bounded pool: for each item it opens the URL in an inactive `chrome.tabs.create` tab. If the tab receives a file response, Chrome starts the download; the extension correlates the new download back to the source tab via `chrome.downloads.onCreated` and closes the tab. If no download starts within 90s (e.g. the user ignored a password prompt), the tab is closed and the item is retried or marked failed.

Why tabs instead of `chrome.downloads.download`: the `/takeout/download?...` URL returns either a 302 to the signed file URL OR an HTML password-confirmation page. `chrome.downloads.download` saves whatever it gets, so an HTML response becomes a `pwd.htm` file on disk. Navigating a tab to the same URL lets the browser do the right thing with each content-type.

## Notes

- Takeout signed URLs expire after ~1 week. If downloads fail with 401/403, the export itself has expired — regenerate it from Takeout.
- Failures retry up to 2 times with a 3s backoff before being marked failed.
- Worker state persists in `chrome.storage.session`, so a torn-down service worker picks back up from the next `downloads.onChanged` event.

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
