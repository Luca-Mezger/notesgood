import { requestPersistence } from './db';
import { openEditor, type EditorHandle } from './editor';
import { showLibrary } from './library';
import { toast } from './ui';
import { applyTheme } from './theme';
import { watchForUpdates } from './update';
import { observeStudy } from './activity-observer';
import { sync, syncEnabled } from './sync';

applyTheme();
watchForUpdates();

const root = document.getElementById('app')!;
let editor: EditorHandle | null = null;
let routing = Promise.resolve();
let study: Awaited<ReturnType<typeof observeStudy>> = null;

/** Routes: `#/n/<notebook id>` opens the editor, anything else shows the library. */
function route() {
  routing = routing.then(async () => {
    if (study) { await study.close(); study = null; }
    if (editor) { await editor.close(); editor = null; }
    if (location.hash === '#/analytics') { const { showAnalytics } = await import('./analytics'); await showAnalytics(root); return; }
    const m = location.hash.match(/^#\/n\/(.+)$/);
    if (m) {
      try {
        editor = await openEditor(root, m[1], () => { location.hash = ''; });
        try { study = await observeStudy(root, m[1]); } catch (e) { console.warn('Analytics unavailable; editor remains ready.', e); }
        return;
      } catch (e) {
        console.error(e);
        toast('That notebook could not be opened.');
        history.replaceState(null, '', location.pathname);
      }
    }
    const lib = await showLibrary(root, (id) => { location.hash = '#/n/' + id; });
    // PDFs opened through the installed app ("Open with")
    const lq = (window as any).launchQueue;
    lq?.setConsumer?.(async (params: any) => {
      const fh = params?.files?.[0];
      if (fh) lib.importPdf(await fh.getFile());
    });
  }).catch((e) => { console.error(e); toast('Something went wrong: ' + (e?.message ?? e)); });
}

window.addEventListener('hashchange', route);
route();
requestPersistence();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Reading-only sessions and analytics also sync; this never runs in an input handler.
const syncWhenOnline = () => { if (navigator.onLine && document.visibilityState !== 'hidden' && syncEnabled()) void sync(); };
window.setInterval(syncWhenOnline, 60000);
window.addEventListener('online', syncWhenOnline);
