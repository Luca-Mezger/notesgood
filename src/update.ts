// Keeps an open app on the newest installed build.
// The build id baked into this bundle is compared with dist/version.js; when they differ the page
// reloads, but only at a safe moment: library showing, no dialog, no import or toast in progress.
// In the editor nothing happens until you go back to the library, so writing is never interrupted.
declare const __BUILD__: string;

const CURRENT = typeof __BUILD__ === 'string' ? __BUILD__ : '';
const TRIED = 'opplinotes.reloadedFor';
let pending: string | null = null;

async function latestBuild(): Promise<string | null> {
  try {
    const res = await fetch('version.js?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.text()).match(/BUILD\s*=\s*"([^"]+)"/)?.[1] ?? null;
  } catch { return null; }
}

function safeToReload(): boolean {
  return document.visibilityState === 'visible' && !!document.querySelector('.library') &&
    !document.querySelector('.editor, .modal-back, .popover, .toast');
}

async function check() {
  if (!CURRENT) return;
  if (!pending) {
    const latest = await latestBuild();
    if (latest && latest !== CURRENT) pending = latest;
  }
  if (!pending || !safeToReload()) return;
  // Reload once per new build: if the page still runs old code afterwards (half-copied install),
  // don't loop; the next build or a manual restart picks it up.
  try { if (sessionStorage.getItem(TRIED) === pending) return; sessionStorage.setItem(TRIED, pending); } catch { /* storage blocked */ }
  location.reload();
}

export function watchForUpdates() {
  if (!CURRENT) return;
  setInterval(check, 30_000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void check(); });
  window.addEventListener('focus', () => void check());
  window.addEventListener('hashchange', () => setTimeout(check, 500));
}
