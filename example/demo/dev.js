// Live reload for `npm run dev`. The dev script writes dev-reload.json on
// every change; without it (no dev server running) both functions do nothing.

const MARKER = 'dev-reload.json';
const REOPEN = 'byokdemoDevReopen';

async function readMarker() {
  try {
    const res = await fetch(chrome.runtime.getURL(MARKER), { cache: 'no-store' });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** Page side: poll the marker; reload the page, or the whole extension when the worker's files changed. */
export async function watchForChanges() {
  const first = await readMarker();
  if (!first) return;
  let seen = first.stamp;
  setInterval(async () => {
    const next = await readMarker();
    if (!next || next.stamp === seen) return;
    seen = next.stamp;
    if (!next.worker) return location.reload();
    // Reloading the extension closes this tab: the worker reopens it.
    await chrome.storage.local.set({ [REOPEN]: true });
    chrome.runtime.reload();
  }, 1000);
}

/** Worker side: after a dev reload, reopen the demo page. */
export async function reopenAfterReload() {
  const { [REOPEN]: reopen } = await chrome.storage.local.get(REOPEN);
  if (!reopen) return;
  await chrome.storage.local.remove(REOPEN);
  await chrome.tabs.create({ url: chrome.runtime.getURL('page.html') });
}
