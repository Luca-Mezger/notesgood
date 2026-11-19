import { requestPersistence } from './db';
import { openEditor, type EditorHandle } from './editor';
import { showLibrary } from './library';
import { toast } from './ui';
import { applyTheme } from './theme';
import { watchForUpdates } from './update';

applyTheme();
watchForUpdates();

const root = document.getElementById('app')!;
let editor: EditorHandle | null = null;
let routing = Promise.resolve();

/** Routes: `#/n/<notebook id>` opens the editor, anything else shows the library. */
function route() {
  routing = routing.then(async () => {
    if (editor) { await editor.close(); editor = null; }
    const m = location.hash.match(/^#\/n\/(.+)$/);
    if (m) {
      try {
        editor = await openEditor(root, m[1], () => { location.hash = ''; });
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
