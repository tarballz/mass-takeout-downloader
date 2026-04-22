// Scrapes archive-part download links from Takeout manage pages.
// Responds to {type: "SCAN_LINKS"} from the popup.

function filenameFromUrl(url) {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop();
    return last && last.includes(".") ? decodeURIComponent(last) : null;
  } catch {
    return null;
  }
}

function isDownloadLink(url) {
  if (!url) return false;
  if (url.hostname === "takeout-download.usercontent.google.com") return true;
  if (
    url.hostname === "takeout.google.com" &&
    url.pathname === "/takeout/download" &&
    url.searchParams.has("j") &&
    url.searchParams.has("i")
  ) {
    return true;
  }
  return false;
}

function labelFor(url) {
  // For /takeout/download?j=<job>&i=<part>, build a stable label.
  if (url.pathname === "/takeout/download") {
    const j = url.searchParams.get("j") || "";
    const i = url.searchParams.get("i") || "";
    const shortJob = j.slice(0, 8);
    return `takeout-${shortJob}-part-${i}`;
  }
  return filenameFromUrl(url.toString()) || "takeout-part";
}

function scanLinks() {
  const seen = new Map();

  for (const a of document.querySelectorAll("a[href]")) {
    let u;
    try {
      u = new URL(a.href, location.href);
    } catch {
      continue;
    }
    if (!isDownloadLink(u)) continue;

    const url = u.toString();
    if (seen.has(url)) continue;

    // Don't force a filename for /takeout/download? URLs — they redirect to a
    // signed URL that carries Content-Disposition with the real archive name.
    const filename =
      a.getAttribute("download") ||
      (u.hostname === "takeout-download.usercontent.google.com"
        ? filenameFromUrl(url)
        : null);

    seen.set(url, { url, filename, label: labelFor(u) });
  }

  return Array.from(seen.values());
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "SCAN_LINKS") {
    sendResponse({ links: scanLinks() });
    return true;
  }
});
