// Library: overview of all notebooks with folders, search, creation and PDF import.
import { db } from './db';
import { PAPER_COLORS } from './render';
import { makeCover } from './thumb';
import { uid, type Notebook, type Page, type Tpl } from './types';
import { confirmDlg, download, fmtDate, h, icon, iconBtn, menu, modal, promptText, toast, type MenuItem } from './ui';
import { markAllDirty, onSync, saveSyncConfig, sync, syncConfig, syncEnabled } from './sync';
import { collectPdfSources, directoryFiles, importFolders, importTitle, pdfHash, type PdfSource } from './import';
import { folderContains, folderName, folderParent, folderPaths, folderRemap, folderTarget, joinFolder } from './folders';

const A4: [number, number] = [595, 842];
const TPLS: [Tpl, string][] = [['blank', 'Blank'], ['lined', 'Lined'], ['grid', 'Grid'], ['dots', 'Dotted']];

type Src = PdfSource;

type Filter = { k: 'all' } | { k: 'fav' } | { k: 'folder'; name: string };
type LibraryDrag = { k: 'notebook'; id: string } | { k: 'folder'; name: string };
const DRAG_TYPE = 'application/x-notesgood-library';

export async function showLibrary(root: HTMLElement, openNotebook: (id: string) => void) {
  let notebooks = await db.notebooks();
  let folders = folderPaths([...(await db.meta<string[]>('folders') ?? []), ...notebooks.map((nb) => nb.folder)]);
  let filter: Filter = { k: 'folder', name: '' };
  try {
    const saved = JSON.parse(sessionStorage.getItem('notesgood.library.view') ?? 'null');
    if (saved?.k === 'all' || saved?.k === 'fav' || (saved?.k === 'folder' && (saved.name === '' || folders.includes(saved.name)))) filter = saved;
  } catch { /* Start at Documents if a saved view is invalid. */ }
  let query = '';
  let sort = localStorage.getItem('margin.sort') ?? 'updated';
  let descending = localStorage.getItem('notesgood.sort.desc') !== null ? localStorage.getItem('notesgood.sort.desc') === 'true' : sort !== 'title';
  let importing = false, scanning = false, disposed = false;
  let quickPick = false;
  const autoEnabled = () => localStorage.getItem('goodnotes.auto') !== 'off';
  const importMessage = h('span', { role: 'status', 'aria-live': 'polite' });
  const autoToggle = h('button', { class: 'btn small', type: 'button', onclick: () => {
    localStorage.setItem('goodnotes.auto', autoEnabled() ? 'off' : 'on');
    setImportStatus(autoEnabled() ? 'Automatic Goodnotes import is on.' : 'Automatic Goodnotes import is paused.');
    if (autoEnabled()) void scanGoodnotes();
  } });
  const importStatus = h('div', { class: 'import-status', hidden: true }, importMessage,
    h('button', { class: 'btn small', type: 'button', onclick: () => void scanGoodnotes(true) }, 'Check now'), autoToggle);

  const grid = h('div', { class: 'grid' });
  const navigation = h('div', { class: 'library-navigation' });
  const folderGrid = h('div', { class: 'folder-grid', 'aria-label': 'Folders' });
  const folderSection = h('section', { class: 'folder-section' }, folderGrid);
  const earlierImports = h('div', { class: 'earlier-imports' });
  const notebookHeading = h('h2', { class: 'section-title' });
  const sortDirection = iconBtn('down', 'Sort descending', () => {
    descending = !descending;
    localStorage.setItem('notesgood.sort.desc', String(descending));
    renderGrid();
  });
  const sortSelect = h('select', { class: 'field sort', 'aria-label': 'Sort by', onchange: (e: Event) => {
    sort = (e.target as HTMLSelectElement).value;
    localStorage.setItem('margin.sort', sort);
    descending = sort !== 'title';
    localStorage.setItem('notesgood.sort.desc', String(descending));
    renderGrid();
  } }, ...[['title', 'Name'], ['updated', 'Last edited'], ['created', 'Date created']].map(([v, l]) => h('option', { value: v, selected: v === sort }, l)));
  const fileInput = h('input', {
    type: 'file', accept: 'application/pdf,.pdf,.zip,.goodnotes,.notesgood,.margin', multiple: true, hidden: true,
    onchange: () => { const fs = [...(fileInput.files ?? [])]; const quick = quickPick; quickPick = false; fileInput.value = ''; if (fs.length) void importFiles(fs.map((file) => ({ file, path: file.name })), quick); },
    oncancel: () => { quickPick = false; },
  });

  const dirInput = h('input', {
    type: 'file', webkitdirectory: true, multiple: true, hidden: true,
    onchange: () => { const fs = [...(dirInput.files ?? [])]; const quick = quickPick; quickPick = false; dirInput.value = ''; if (fs.length) void importFiles(fs.map((file) => ({ file, path: file.webkitRelativePath || file.name })), quick); },
    oncancel: () => { quickPick = false; },
  });
  const syncBtn: HTMLButtonElement = h('button', { class: 'btn syncbtn', type: 'button', title: 'Sync', onclick: () => syncDialog() }, icon('cloud', 18), h('span', { class: 'label' }, 'Sync'));
  const offSync = onSync((s, msg) => {
    syncBtn.dataset.state = s;
    syncBtn.title = s === 'off' ? 'Sync is off. Click to set it up.' : msg;
    syncBtn.querySelector('span')!.textContent = s === 'off' ? 'Sync' : s === 'busy' ? 'Syncing…' : s === 'error' ? 'Sync error' : 'Synced';
  });
  const libMore: HTMLButtonElement = iconBtn('more', 'Backup options', () => menu(libMore, [
    { label: 'Sync settings…', icon: 'cloud', action: syncDialog },
    { label: 'Back up all notebooks', icon: 'export', action: () => backup(notebooks, 'Opplinotes backup ' + new Date().toISOString().slice(0, 10)) },
    { label: 'Restore from backup…', icon: 'import', action: () => fileInput.click() },
  ]));
  // One import entry point instead of several equal-weight buttons.
  const importBtn: HTMLButtonElement = h('button', { class: 'btn', type: 'button', 'aria-label': 'Import', title: 'Import PDFs, folders, backups or Goodnotes exports',
    onclick: () => menu(importBtn, [
      { label: 'PDFs, ZIP or backup…', icon: 'pdf', action: () => fileInput.click() },
      { label: 'Folder of PDFs…', icon: 'folder', action: () => dirInput.click() },
      { label: 'From Goodnotes', icon: 'import', action: goodnotesHelp },
    ]) }, icon('import', 18), h('span', { class: 'label' }, 'Import'));

  // Studio layout: a sidebar for finding things (search, views, folder tree, sync) and a main area for the content.
  const sideNav = h('nav', { class: 'side-nav', role: 'group', 'aria-label': 'Library view' });
  const sideTree = h('div', { class: 'side-tree', 'aria-label': 'Folder tree' });
  const closeSidebar = () => view.classList.remove('side-open');
  const sidebar = h('aside', { class: 'sidebar' },
    h('div', { class: 'side-brand' }, h('h1', null, 'Opplinotes'),
      iconBtn('close', 'Close sidebar', closeSidebar, 'side-close')),
    h('label', { class: 'search' }, icon('search', 17),
      h('input', { type: 'search', placeholder: 'Search', 'aria-label': 'Search notes', oninput: (e: Event) => { query = (e.target as HTMLInputElement).value.toLowerCase(); renderGrid(); } })),
    sideNav,
    h('div', { class: 'side-label' }, h('span', null, 'Folders'), iconBtn('plus', 'New folder', addFolder, 'side-add')),
    sideTree,
    h('div', { class: 'side-foot' }, syncBtn, libMore));
  const view = h('div', { class: 'library' },
    sidebar,
    h('div', { class: 'side-scrim', onclick: closeSidebar }),
    h('main', { class: 'lib-main' },
      h('header', { class: 'lib-head' },
        iconBtn('menu', 'Show sidebar', () => view.classList.add('side-open'), 'menu-btn'),
        navigation,
        h('div', { class: 'lib-actions' },
          h('label', { class: 'sort-controls' }, h('span', null, 'Sort'), sortSelect, sortDirection),
          importBtn,
          h('button', { class: 'btn primary', type: 'button', 'aria-label': 'New notebook', onclick: newNotebook }, icon('plus', 18), h('span', { class: 'label' }, 'New notebook'))),
        fileInput, dirInput),
      folderSection, earlierImports, notebookHeading, grid));

  // Drop a PDF anywhere on the library to import it
  view.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); view.classList.add('dropping'); } });
  view.addEventListener('dragleave', (e) => { if (!view.contains(e.relatedTarget as Node)) view.classList.remove('dropping'); });
  view.addEventListener('drop', (e) => {
    e.preventDefault();
    view.classList.remove('dropping');
    if (e.dataTransfer?.types.includes('Files')) {
      const destination = currentFolder();
      droppedFiles(e.dataTransfer).then((fs) => { if (fs.length) void importFiles(fs, false, false, destination); }).catch((error) => toast(error.message));
    }
  });

  root.replaceChildren(view);
  renderNavigation();
  renderGrid();

  // Sync whenever the library is shown, when the app comes back to the foreground, and every minute.
  const refreshAfterSync = async () => {
    if (!(await sync())) return;
    if (importing) return; // An importer is updating this list; refresh on the next sync.
    const previouslyUsed = new Set(folderPaths(notebooks.map((nb) => nb.folder)));
    notebooks = await db.notebooks();
    const stillUsed = new Set(folderPaths(notebooks.map((nb) => nb.folder)));
    // Retire old populated paths after another device moves/renames their contents.
    // Locally created empty folders remain available.
    folders = folders.filter((path) => !previouslyUsed.has(path) || stillUsed.has(path));
    const missing = [...new Set(notebooks.map((nb) => nb.folder))].filter((f) => f && !folders.includes(f));
    folders = folderPaths([...folders, ...missing]);
    await db.putMeta('folders', folders);
    if (filter.k === 'folder' && filter.name && !folders.includes(filter.name)) filter = { k: 'folder', name: '' };
    renderNavigation(); renderGrid();
  };
  if (syncEnabled()) refreshAfterSync();
  const timer = window.setInterval(() => { if (document.visibilityState === 'visible') { if (syncEnabled()) refreshAfterSync(); void scanGoodnotes(); } }, 60000);
  const onVisible = () => { if (document.visibilityState === 'visible') { if (syncEnabled()) refreshAfterSync(); void scanGoodnotes(); } };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', onVisible);
  const mo = new MutationObserver(() => { if (!view.isConnected) { disposed = true; clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('online', onVisible); offSync(); mo.disconnect(); } });
  mo.observe(root, { childList: true });

  let pushTimer = 0;
  /** Pushes library-level changes (rename, delete, move) a moment after they happen. */
  function pushSoon() {
    if (!syncEnabled()) return;
    clearTimeout(pushTimer);
    pushTimer = window.setTimeout(() => sync(true), 400);
  }

  async function syncDialog() {
    const cfg = syncConfig();
    const url = h('input', { type: 'url', class: 'field', value: cfg.url, placeholder: 'https://your-domain.com/notesgood/sync.php', autocomplete: 'off' });
    const key = h('input', { type: 'password', class: 'field', value: cfg.key, placeholder: 'The secret from sync-key.txt', autocomplete: 'off' });
    const status = h('p', { class: 'hint' }, cfg.url ? (cfg.error ? 'Last attempt failed: ' + cfg.error : cfg.last ? 'Last synced ' + new Date(cfg.last).toLocaleString() : 'Not synced yet') : 'Sync is off. Notes stay on this device only.');
    const body = h('div', { class: 'form' },
      h('p', null, 'Keeps your notebooks the same on every device that uses the same server and secret. The server is the sync.php or sync.mjs from the project’s server folder; see the README for setup.'),
      h('label', null, 'Server URL', url),
      h('label', null, 'Secret', key),
      status,
      h('div', { class: 'row' },
        h('button', { class: 'btn small', type: 'button', onclick: async () => {
          const next = { ...cfg, url: url.value.trim(), key: key.value };
          saveSyncConfig(next);
          status.textContent = 'Uploading everything on this device…';
          await markAllDirty();
          const ok = await sync();
          const c = syncConfig();
          status.textContent = c.error ? 'Failed: ' + c.error : 'Done. Everything on this device is on the server now.';
          if (!c.error && ok) refreshAfterSync();
        } }, 'Upload all notes from this device'),
        h('button', { class: 'btn small', type: 'button', onclick: () => { saveSyncConfig({ ...cfg, url: '', key: '' }); url.value = ''; key.value = ''; status.textContent = 'Sync is off.'; } }, 'Turn off')));
    const ok = await modal({ title: 'Sync', body, ok: 'Save & sync', onOk: () => {
      const u = url.value.trim();
      if (u && !/^https?:\/\//.test(u)) { toast('The server URL must start with https:// (or http:// for local testing).'); return false; }
      saveSyncConfig({ ...syncConfig(), url: u, key: key.value });
    } });
    if (ok && syncEnabled()) refreshAfterSync();
  }

  async function goodnotesHelp() {
    if (!importMessage.textContent) setImportStatus(autoEnabled() ? 'Automatic import is on.' : 'Automatic import is paused.');
    const space = h('select', { class: 'field', onchange: () => localStorage.setItem('goodnotes.margin', space.value) },
      ...[['0', 'Keep the original page layout'], ['0.5', 'Add half a page of writing space'], ['1', 'Add a full page of writing space']].map(([value, label]) =>
        h('option', { value, selected: Number(value) === goodnotesMargin() }, label)));
    const body = h('div', { class: 'form' },
      h('p', null, 'Choose exported PDFs, a ZIP, or a whole folder. Opplinotes keeps folders and skips PDFs you have already imported.'),
      h('label', null, 'Page layout', space),
      h('div', { class: 'import-choices' },
        h('button', { class: 'btn primary', type: 'button', onclick: () => { quickPick = true; fileInput.click(); } }, 'Choose PDFs or ZIP'),
        h('button', { class: 'btn', type: 'button', onclick: () => { quickPick = true; dirInput.click(); } }, 'Choose a folder'),
        (window as any).showDirectoryPicker ? h('button', { class: 'btn', type: 'button', onclick: watchBackupFolder }, 'Watch a backup folder…') : null),
      h('p', null, 'Goodnotes Web, Windows, or Android: open a notebook → Share → Export as PDF. You can export notebooks one at a time; a full-library export is not required.'),
      h('p', null, 'On iPad or Mac, select documents or folders in the library → Export → PDF. A PDF folder export can be imported as a ZIP.'),
      importStatus,
      h('p', { class: 'hint' }, 'On this Nix desktop, PDFs downloaded from the Goodnotes app into Downloads are picked up automatically while the library is open. Other downloads and files prepared for Goodnotes are ignored.'),
      h('p', { class: 'hint' }, 'A watched folder must contain PDF exports, for example a local copy of a Goodnotes Auto Backup folder. Your browser may ask you to reconnect it after restarting.'),
      h('p', { class: 'hint' }, 'Native .goodnotes files need to be exported as PDF first. Existing handwriting stays visible in the PDF, but cannot be erased as individual strokes.'));
    await modal({ title: 'Import from Goodnotes', body, ok: 'Done', cancel: null });
  }

  function goodnotesMargin(): number {
    const value = Number(localStorage.getItem('goodnotes.margin') ?? 0);
    return [0, 0.5, 1].includes(value) ? value : 0;
  }

  function setImportStatus(text: string) {
    if (disposed) return;
    importStatus.hidden = false;
    importMessage.textContent = text;
    autoToggle.textContent = autoEnabled() ? 'Pause auto-import' : 'Resume auto-import';
  }

  async function watchBackupFolder() {
    try {
      const handle = await (window as any).showDirectoryPicker({ mode: 'read', id: 'goodnotes-backup' });
      await db.putMeta('goodnotes.watch', handle);
      await db.putMeta('goodnotes.watchedSeen', {});
      localStorage.setItem('goodnotes.auto', 'on');
      document.querySelector<HTMLButtonElement>('.modal-actions .btn.primary')?.click();
      await scanGoodnotes();
    } catch (e: any) {
      if (e?.name !== 'AbortError') toast('Could not watch that folder. Try “Choose a folder” instead.');
    }
  }

  /** Poll only while the library is open. Never read arbitrary Downloads files. */
  async function scanGoodnotes(manual = false, locked = false): Promise<void> {
    if (disposed || scanning || importing || (!autoEnabled() && !manual)) return;
    if (!locked && navigator.locks) {
      await navigator.locks.request('notesgood-import', { ifAvailable: true }, async (lock) => { if (lock) await scanGoodnotes(manual, true); });
      return;
    }
    scanning = true;
    try {
      const sources: Src[] = [];
      if (['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) {
        const response = await fetch('api/goodnotes/exports', { headers: { 'X-Notesgood-Local': '1' } });
        if (response.ok) {
          const { files, available } = await response.json() as { files: { id?: string; name: string; dir?: string; size: number; lastModified: number }[]; available: boolean };
          const seen = await db.meta<Record<string, string>>('goodnotes.localSeen') ?? {};
          for (const file of files) {
            const signature = `${file.size}:${file.lastModified}${file.id ? ':source-v1' : ''}`;
            const id = file.id ?? file.name;
            if (seen[id] === signature) continue;
            sources.push({ name: file.name, dir: file.dir ?? 'Goodnotes', sourceId: file.id, data: async () => {
              const r = await fetch('api/goodnotes/file?name=' + encodeURIComponent(id), { headers: { 'X-Notesgood-Local': '1' } });
              if (!r.ok) throw new Error('Could not read export');
              return r.arrayBuffer();
            }, onImported: async () => { seen[id] = signature; await db.putMeta('goodnotes.localSeen', seen); } });
          }
          setImportStatus(!available ? 'Automatic pickup is unavailable right now. Use “From Goodnotes” to choose PDFs.' : sources.length ? `Found ${sources.length} new Goodnotes exports.` : 'Waiting for PDF exports from Goodnotes. Save them to Downloads.');
        }
      }
      const handle = await db.meta<any>('goodnotes.watch');
      if (handle) {
        let permission = await handle.queryPermission({ mode: 'read' });
        if (permission !== 'granted' && manual) permission = await handle.requestPermission({ mode: 'read' });
        if (permission === 'granted') {
          const seen = await db.meta<Record<string, string>>('goodnotes.watchedSeen') ?? {};
          for (const { file, path } of await directoryFiles(handle)) {
            const signature = `${file.size}:${file.lastModified}`;
            if (seen[path] === signature) continue;
            sources.push({ name: file.name, dir: path.split('/').slice(0, -1).join('/') || handle.name, data: () => file.arrayBuffer(),
              onImported: async () => { seen[path] = signature; await db.putMeta('goodnotes.watchedSeen', seen); } });
          }
          if (!sources.length) setImportStatus(`Goodnotes backup folder “${handle.name}” is up to date.`);
        } else setImportStatus(`Reconnect “${handle.name}” with “Check now” to continue automatic import.`);
      }
      if (sources.length && !disposed) {
        importing = true;
        notebooks = await db.notebooks();
        await importMany(sources, 0, true, !manual);
      }
    } catch (e) { console.warn('Goodnotes export check failed', e); if (manual) toast('Could not check Goodnotes exports. You can still choose files to import.'); }
    finally { importing = false; scanning = false; }
  }

  async function backup(list: Notebook[], name: string) {
    if (!list.length) { toast('There is nothing to back up yet.'); return; }
    try {
      toast('Preparing backup…', true);
      const { exportBackup, safeName } = await import('./export');
      download(await exportBackup(list), safeName(name) + '.notesgood');
      toast('Backup saved to your downloads.');
    } catch (e: any) { console.error(e); toast('Backup failed: ' + (e?.message ?? e)); }
  }

  async function pdfExport(nb: Notebook) {
    try {
      toast('Preparing PDF…', true);
      const { exportPdf, safeName } = await import('./export');
      const byId = new Map((await db.pages(nb.id)).map((p) => [p.id, p]));
      const pages = nb.pages.map((id) => byId.get(id)).filter((p): p is Page => !!p);
      download(await exportPdf(nb, pages, (d, t) => toast(`Preparing PDF… page ${d} of ${t}`, true)), safeName(nb.title) + '.pdf');
      toast('PDF saved to your downloads.');
    } catch (e: any) { console.error(e); toast('Export failed: ' + (e?.message ?? e)); }
  }

  function currentFolder(): string { return filter.k === 'folder' ? filter.name : ''; }

  function navigate(next: Filter) {
    filter = next;
    sessionStorage.setItem('notesgood.library.view', JSON.stringify(filter));
    query = '';
    view.querySelector<HTMLInputElement>('input[type="search"]')!.value = '';
    renderNavigation(); renderGrid();
  }

  function renderNavigation() {
    folders = folderPaths([...folders, ...notebooks.map((nb) => nb.folder)]);
    const crumbs = h('nav', { class: 'breadcrumbs', 'aria-label': 'Folder path' });
    crumbs.hidden = filter.k === 'folder' && !filter.name;
    const crumb = (label: string, path: string, current: boolean) => {
      const button = h('button', { type: 'button', class: 'breadcrumb', 'aria-current': current ? 'page' : null,
        onclick: () => navigate({ k: 'folder', name: path }) }, label);
      dropTarget(button, path);
      return button;
    };
    crumbs.append(crumb('Documents', '', filter.k === 'folder' && !filter.name));
    if (filter.k === 'folder' && filter.name) {
      const parts = filter.name.split(' / ');
      parts.forEach((part, i) => crumbs.append(h('span', { class: 'breadcrumb-separator', 'aria-hidden': 'true' }, '›'), crumb(part, parts.slice(0, i + 1).join(' / '), i === parts.length - 1)));
    } else if (filter.k !== 'folder') crumbs.append(h('span', { class: 'breadcrumb-separator', 'aria-hidden': 'true' }, '›'), h('span', { 'aria-current': 'page' }, filter.k === 'all' ? 'All notebooks' : 'Favourites'));
    navigation.replaceChildren(crumbs,
      h('h2', { class: 'library-title' }, filter.k === 'folder' ? folderName(filter.name) || 'Documents' : filter.k === 'all' ? 'All notebooks' : 'Favourites'));
    renderSidebar();
  }

  function renderSidebar() {
    const count = (n: number) => h('span', { class: 'side-count' }, String(n));
    const views = [
      ['folder', 'Documents', 'inbox', notebooks.filter((nb) => !nb.folder).length],
      ['all', 'All notebooks', 'grid', notebooks.length],
      ['fav', 'Favourites', 'star', notebooks.filter((nb) => nb.fav).length],
    ] as const;
    sideNav.replaceChildren(...views.map(([value, label, ic, n]) => {
      const active = filter.k === value && (filter.k !== 'folder' || !filter.name);
      const button = h('button', { type: 'button', class: 'side-item', 'data-view': value, 'aria-pressed': String(active),
        onclick: () => { navigate(value === 'folder' ? { k: 'folder', name: '' } : { k: value }); closeSidebar(); } },
        icon(ic, 18), h('span', { class: 'side-text' }, label), count(n));
      if (value === 'folder') dropTarget(button, '');
      return button;
    }));
    // Show top-level folders, plus the children of every folder on the path to the current one.
    const current = currentFolder();
    const open = (path: string) => path === '' || folderContains(path, current);
    const visible = folders.filter((f) => open(folderParent(f))).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    sideTree.replaceChildren(...visible.map((path) => {
      const depth = path.split(' / ').length - 1;
      const hasChildren = folders.some((f) => folderParent(f) === path);
      const row = h('button', { type: 'button', class: 'side-item side-folder', 'data-folder-path': path, 'aria-pressed': String(filter.k === 'folder' && filter.name === path),
        style: { paddingLeft: 10 + depth * 16 + 'px' }, title: path,
        onclick: () => { navigate({ k: 'folder', name: path }); closeSidebar(); } },
        h('span', { class: 'side-caret' + (hasChildren ? '' : ' none') + (open(path) && hasChildren ? ' open' : '') }, icon('chevron', 14)),
        icon('folder', 17), h('span', { class: 'side-text' }, folderName(path)),
        count(notebooks.filter((nb) => folderContains(path, nb.folder)).length));
      row.addEventListener('contextmenu', (e) => { e.preventDefault(); folderMenu(row, path); });
      dropTarget(row, path);
      return row;
    }));
    if (!visible.length) sideTree.append(h('p', { class: 'side-empty' }, 'No folders yet'));
  }

  async function addFolder() {
    const label = await promptText('New folder', '', 'Create');
    if (label === null) return;
    try {
      const name = folderTarget(currentFolder(), label);
      if (folders.includes(name)) { toast('A folder with that name already exists here.'); return; }
      folders = folderPaths([...folders, name]);
      await db.putFolders(folders);
      renderNavigation(); renderGrid();
    } catch (e) { toast((e as Error).message); }
  }

  async function relocateFolder(from: string, to: string) {
    const latest = await db.notebooks();
    const paths = folderPaths([...folders, ...latest.map((nb) => nb.folder)]);
    const mapping = folderRemap(paths, from, to);
    if (!mapping.size) return;
    const changed = latest.filter((nb) => mapping.has(nb.folder)).map((nb) => ({ ...nb, folder: mapping.get(nb.folder)!, updated: Date.now(), folderMoved: true }));
    const next = folderPaths(paths.map((path) => mapping.get(path) ?? path));
    await db.putFolders(next, changed);
    notebooks = latest.map((nb) => changed.find((moved) => moved.id === nb.id) ?? nb);
    folders = next;
    if (filter.k === 'folder' && mapping.has(filter.name)) { filter = { k: 'folder', name: mapping.get(filter.name)! }; sessionStorage.setItem('notesgood.library.view', JSON.stringify(filter)); }
    renderNavigation(); renderGrid(); pushSoon();
  }

  async function moveNotebook(id: string, destination: string) {
    const latest = await db.notebook(id);
    if (!latest || latest.folder === destination) return;
    if (destination && !folders.includes(destination)) throw new Error('That folder no longer exists.');
    const moved = { ...latest, folder: destination, updated: Date.now(), folderMoved: true };
    await db.putFolders(folders, [moved]);
    notebooks = notebooks.map((nb) => nb.id === id ? moved : nb);
    renderNavigation(); renderGrid(); pushSoon();
    toast('Moved to ' + (destination || 'Documents') + '.');
  }

  function destinationSelect(exclude?: string) {
    return h('select', { class: 'field', 'aria-label': 'Destination folder' }, h('option', { value: '' }, 'Documents'),
      ...folders.filter((f) => !exclude || !folderContains(exclude, f)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map((f) => h('option', { value: f }, f)));
  }

  function folderMenu(anchor: HTMLElement, name: string) {
    menu(anchor, [
      { label: 'Rename folder', icon: 'pen', action: async () => {
        const next = await promptText('Rename folder', folderName(name));
        if (next === null) return;
        try { await relocateFolder(name, folderTarget(folderParent(name), next)); }
        catch (e) { toast((e as Error).message); }
      } },
      { label: 'Move folder…', icon: 'folder', action: async () => {
        const select = destinationSelect(name);
        select.value = folderParent(name);
        if (!(await modal({ title: 'Move ' + folderName(name), body: select, ok: 'Move' }))) return;
        try { await relocateFolder(name, joinFolder(select.value, folderName(name))); }
        catch (e) { toast((e as Error).message); }
      } },
      { label: 'Delete folder', icon: 'trash', danger: true, action: async () => {
        const parent = folderParent(name);
        if (!(await confirmDlg(`Delete folder “${folderName(name)}”?`, `The folder and its subfolders are removed. All notebooks inside are kept and move to ${parent || 'Documents'}.`))) return;
        const latest = await db.notebooks();
        const changed = latest.filter((nb) => folderContains(name, nb.folder)).map((nb) => ({ ...nb, folder: parent, updated: Date.now(), folderMoved: true }));
        const next = folders.filter((f) => !folderContains(name, f));
        await db.putFolders(next, changed);
        notebooks = latest.map((nb) => changed.find((moved) => moved.id === nb.id) ?? nb); folders = next;
        pushSoon(); navigate({ k: 'folder', name: parent });
      } },
    ]);
  }

  let dragging: LibraryDrag | null = null;
  function draggable(element: HTMLElement, item: LibraryDrag, label: string) {
    element.draggable = true;
    element.addEventListener('dragstart', (e) => {
      if (!e.dataTransfer) return;
      e.stopPropagation(); dragging = item;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(item));
      e.dataTransfer.setData('text/plain', label);
      element.classList.add('dragging');
    });
    element.addEventListener('dragend', () => {
      dragging = null; element.classList.remove('dragging');
      view.querySelectorAll('.drop-active').forEach((target) => target.classList.remove('drop-active'));
    });
  }

  function dropTarget(element: HTMLElement, destination: string) {
    element.dataset.dropFolder = destination;
    const allowed = () => {
      if (!dragging) return true;
      if (dragging.k === 'folder') return !folderContains(dragging.name, destination) && folderParent(dragging.name) !== destination;
      const id = dragging.id;
      return notebooks.find((nb) => nb.id === id)?.folder !== destination;
    };
    element.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes('Files')) {
        e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; element.classList.add('drop-active'); return;
      }
      if (!e.dataTransfer?.types.includes(DRAG_TYPE) || !allowed()) return;
      e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'; element.classList.add('drop-active');
    });
    element.addEventListener('dragleave', (e) => { if (!element.contains(e.relatedTarget as Node)) element.classList.remove('drop-active'); });
    element.addEventListener('drop', (e) => {
      if (e.dataTransfer?.types.includes('Files')) {
        e.preventDefault(); e.stopPropagation(); element.classList.remove('drop-active');
        void droppedFiles(e.dataTransfer).then((files) => importFiles(files, false, false, destination)).catch((error) => toast(error.message));
        return;
      }
      if (!e.dataTransfer?.types.includes(DRAG_TYPE)) return;
      e.preventDefault(); e.stopPropagation(); element.classList.remove('drop-active');
      if (importing || scanning) { toast('Please wait for the import to finish before moving notes.'); return; }
      try {
        const item = JSON.parse(e.dataTransfer.getData(DRAG_TYPE)) as LibraryDrag;
        let operation: Promise<void>;
        if (item?.k === 'notebook' && typeof item.id === 'string') operation = moveNotebook(item.id, destination);
        else if (item?.k === 'folder' && typeof item.name === 'string') operation = relocateFolder(item.name, joinFolder(destination, folderName(item.name)));
        else return;
        void operation.catch((error) => toast(error.message));
      } catch { toast('That item could not be moved.'); }
      dragging = null;
    });
  }

  function folderCard(path: string): HTMLElement {
    const contents = notebooks.filter((nb) => folderContains(path, nb.folder));
    const subfolders = folders.filter((f) => folderParent(f) === path).length;
    const more = iconBtn('more', 'Folder options for ' + folderName(path), (e) => { e.stopPropagation(); folderMenu(more, path); }, 'folder-more');
    const tile = h('article', { class: 'folder-card', 'data-folder': path },
      h('button', { class: 'folder-open', type: 'button', 'aria-label': 'Open folder ' + path, onclick: () => navigate({ k: 'folder', name: path }) },
        h('div', { class: 'folder-art' }, icon('folder', 104)),
        h('h3', null, folderName(path)), h('p', null, `${contents.length} ${contents.length === 1 ? 'notebook' : 'notebooks'}` + (subfolders ? ` · ${subfolders} ${subfolders === 1 ? 'folder' : 'folders'}` : ''))), more);
    tile.addEventListener('contextmenu', (e) => { e.preventDefault(); folderMenu(more, path); });
    draggable(tile, { k: 'folder', name: path }, folderName(path)); dropTarget(tile, path);
    return tile;
  }

  function renderGrid() {
    renderSidebar();
    const direction = descending ? -1 : 1;
    const compareName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
    sortDirection.replaceChildren(icon(descending ? 'down' : 'up'));
    sortDirection.title = descending ? 'Descending — click for ascending' : 'Ascending — click for descending';
    sortDirection.setAttribute('aria-label', sortDirection.title);
    sortDirection.setAttribute('aria-pressed', String(descending));
    const parent = currentFolder();
    const legacy = filter.k === 'folder' && !parent && !query && notebooks.some((nb) => nb.importSourceId) &&
      notebooks.some((nb) => nb.folder === 'Goodnotes') && notebooks.filter((nb) => folderContains('Goodnotes', nb.folder)).every((nb) => nb.folder === 'Goodnotes' && !!nb.importHash && !nb.importSourceId);
    const folderDate = (path: string) => {
      const contents = notebooks.filter((nb) => folderContains(path, nb.folder));
      return contents.length ? (sort === 'created' ? Math.min(...contents.map((nb) => nb.created)) : Math.max(...contents.map((nb) => nb.updated))) : 0;
    };
    const visibleFolders = filter.k === 'fav' ? [] : folders.filter((f) => folderParent(f) === parent && (!query || folderName(f).toLowerCase().includes(query)) && !(legacy && f === 'Goodnotes'));
    visibleFolders.sort((a, b) => direction * ((sort === 'title' ? compareName(folderName(a), folderName(b)) : folderDate(a) - folderDate(b)) || compareName(folderName(a), folderName(b))));
    folderGrid.replaceChildren(...visibleFolders.map(folderCard));
    folderSection.hidden = !visibleFolders.length;
    earlierImports.replaceChildren(...(legacy ? [h('button', { type: 'button', class: 'earlier-imports-link', onclick: () => navigate({ k: 'folder', name: 'Goodnotes' }) },
      icon('folder', 18), `Earlier imports · ${notebooks.filter((nb) => nb.folder === 'Goodnotes').length} notebooks`, h('span', { 'aria-hidden': 'true' }, '›'))] : []));

    let list = notebooks.filter((nb) =>
      (filter.k === 'all' || (filter.k === 'fav' ? nb.fav : query ? !filter.name || folderContains(filter.name, nb.folder) : nb.folder === filter.name)) &&
      (!query || nb.title.toLowerCase().includes(query)));
    list.sort((a, b) => direction * ((sort === 'title' ? compareName(a.title, b.title) : sort === 'created' ? a.created - b.created : a.updated - b.updated) || compareName(a.title, b.title)));
    notebookHeading.textContent = query ? `Search results · ${list.length}` : list.length ? `Notebooks · ${list.length}` : '';
    notebookHeading.hidden = !list.length && !query;

    if (!list.length) {
      grid.replaceChildren(...(visibleFolders.length && !query ? [] : [h('div', { class: 'empty' },
        h('div', { class: 'empty-art' }, icon(query ? 'search' : 'pen', 28)),
        h('h2', null, query ? 'No notes match your search' : notebooks.length ? 'Nothing here yet' : 'Start your first notebook'),
        h('p', null, query ? 'Try a different title.' : 'Create a notebook or drop a PDF here to import it.'),
        query ? null : h('button', { class: 'btn primary', type: 'button', onclick: newNotebook }, icon('plus', 18), 'New notebook'))]));
      return;
    }
    grid.replaceChildren(...list.map(card));
  }

  function card(nb: Notebook): HTMLElement {
    const more = iconBtn('more', 'Notebook options', (e) => { e.stopPropagation(); nbMenu(more, nb); }, 'card-more');
    const tile = h('article', { class: 'card', 'data-notebook': nb.id },
      h('button', { class: 'cover', type: 'button', 'aria-label': 'Open ' + nb.title, onclick: () => openNotebook(nb.id) },
        nb.cover ? h('img', { src: nb.cover, alt: '', draggable: false }) : h('div', { class: 'cover-blank' })),
      h('div', { class: 'card-meta' },
        h('div', { class: 'card-text' },
          h('h3', { title: nb.title }, nb.fav ? h('span', { class: 'fav' }, '★ ') : null, nb.title),
          h('p', null, `${fmtDate(nb.updated)} · ${nb.pages.length} ${nb.pages.length === 1 ? 'page' : 'pages'}`),
          (filter.k !== 'folder' || query) && nb.folder ? h('p', { class: 'notebook-folder' }, nb.folder) : null),
        more));
    draggable(tile, { k: 'notebook', id: nb.id }, nb.title);
    return tile;
  }

  function nbMenu(anchor: HTMLElement, nb: Notebook) {
    const save = async () => { nb.updated = Date.now(); await db.putNotebook(nb); renderGrid(); pushSoon(); };
    const items: MenuItem[] = [
      { label: 'Rename', icon: 'pen', action: async () => { const t = await promptText('Rename notebook', nb.title); if (t) { nb.title = t; save(); } } },
      { label: nb.fav ? 'Remove from favourites' : 'Add to favourites', icon: 'star', action: () => { nb.fav = !nb.fav; save(); } },
      { label: 'Move to folder…', icon: 'folder', action: () => moveToFolder(nb) },
      { label: 'Export as PDF', icon: 'pdf', action: () => pdfExport(nb) },
      { label: 'Save backup file', icon: 'export', action: () => backup([nb], nb.title) },
      { label: 'Delete', icon: 'trash', danger: true, action: async () => {
        if (!(await confirmDlg(`Delete “${nb.title}”?`, 'The notebook and everything written in it will be removed from this device. This can’t be undone.'))) return;
        await db.deleteNotebook(nb.id);
        notebooks = notebooks.filter((n) => n !== nb);
        renderGrid();
        pushSoon();
      } },
    ];
    menu(anchor, items);
  }

  async function moveToFolder(nb: Notebook) {
    const sel = destinationSelect();
    sel.value = nb.folder;
    if (await modal({ title: 'Move to folder', body: sel, ok: 'Move' })) {
      try { await moveNotebook(nb.id, sel.value); } catch (e) { toast((e as Error).message); }
    }
  }

  function tplPicker(value: Tpl, onChange: (t: Tpl) => void): HTMLElement {
    const wrap = h('div', { class: 'seg' });
    const draw = () => wrap.replaceChildren(...TPLS.map(([t, label]) =>
      h('button', { type: 'button', class: t === value ? 'active' : '', onclick: () => { value = t; onChange(t); draw(); } },
        h('span', { class: 'tpl-swatch tpl-' + t }), label)));
    draw();
    return wrap;
  }

  async function newNotebook() {
    let tpl: Tpl = 'lined', paper = 'white', landscape = false;
    const title = h('input', { type: 'text', class: 'field', value: 'Untitled notebook' });
    const paperSel = h('select', { class: 'field', onchange: () => (paper = paperSel.value) },
      h('option', { value: 'white' }, 'White'), h('option', { value: 'cream' }, 'Cream'));
    const orient = h('select', { class: 'field', onchange: () => (landscape = orient.value === 'l') },
      h('option', { value: 'p' }, 'Portrait'), h('option', { value: 'l' }, 'Landscape'));
    const body = h('div', { class: 'form' },
      h('label', null, 'Title', title),
      h('label', null, 'Paper'), tplPicker(tpl, (t) => (tpl = t)),
      h('div', { class: 'row' }, h('label', null, 'Colour', paperSel), h('label', null, 'Orientation', orient)));
    if (!(await modal({ title: 'New notebook', body, ok: 'Create' }))) return;

    const now = Date.now();
    const nb: Notebook = {
      id: uid(), title: title.value.trim() || 'Untitled notebook', folder: currentFolder(), fav: false,
      created: now, updated: now, pages: [], margin: 0, marginTpl: 'blank', tpl, paper: PAPER_COLORS[paper],
    };
    const [w, hh] = landscape ? [A4[1], A4[0]] : A4;
    const page: Page = { id: uid(), nb: nb.id, w, h: hh, bg: { k: 'paper', tpl, color: nb.paper }, els: [] };
    nb.pages = [page.id];
    nb.cover = await makeCover(page, nb);
    await db.putPages([page]);
    await db.putNotebook(nb);
    openNotebook(nb.id);
  }

  /** Dialog asking how much writing space to add beside PDF pages. Resolves null if cancelled. */
  async function askMargin(heading: string, pw: number, ph: number, note: string, titleValue?: string) {
    let margin = Number(localStorage.getItem('margin.lastMargin') ?? 0.5);
    let marginTpl = (localStorage.getItem('margin.lastMarginTpl') as Tpl) ?? 'blank';
    const title = titleValue != null ? h('input', { type: 'text', class: 'field', value: titleValue }) : null;
    const prevPdf = h('div', { class: 'mp-pdf' }, h('span', null, 'PDF page'));
    const prevMargin = h('div', { class: 'mp-margin' }, h('span', null, 'Your notes'));
    const preview = h('div', { class: 'margin-preview' }, prevPdf, prevMargin);
    const out = h('output', null);
    const slider = h('input', { type: 'range', min: 0, max: 500, step: 5, value: Math.round(margin * 100), 'aria-label': 'Writing space on the right', oninput: () => { margin = Number(slider.value) / 100; update(); } });
    const presets = h('div', { class: 'seg' }, ...[[0, 'None'], [0.5, '½ page'], [1, '1 page'], [2, '2 pages'], [5, '5 pages']].map(([v, l]) =>
      h('button', { type: 'button', onclick: () => { margin = v as number; slider.value = String(Math.round(margin * 100)); update(); } }, l as string)));
    const update = () => {
      const total = pw * (1 + margin);
      const scale = Math.min(380 / total, 170 / ph);
      prevPdf.style.width = pw * scale + 'px';
      prevMargin.style.width = pw * margin * scale + 'px';
      prevMargin.style.display = margin ? '' : 'none';
      prevMargin.className = 'mp-margin tpl-' + marginTpl;
      preview.style.height = ph * scale + 'px';
      out.textContent = margin ? `${Math.round(margin * 100)}% of the page width` : 'No extra space';
    };
    update();
    const body = h('div', { class: 'form' },
      title && h('label', null, 'Title', title),
      h('label', null, 'Writing space on the right'),
      preview, presets,
      h('div', { class: 'row slider-row' }, slider, out),
      h('label', null, 'Paper in the writing space'), tplPicker(marginTpl, (t) => { marginTpl = t; update(); }),
      h('p', { class: 'hint' }, note));
    if (!(await modal({ title: heading, body, ok: 'Import' }))) return null;
    localStorage.setItem('margin.lastMargin', String(margin));
    localStorage.setItem('margin.lastMarginTpl', marginTpl);
    return { margin, marginTpl, title: title?.value.trim() ?? '' };
  }

  async function createPdfNotebook(data: ArrayBuffer, sizes: [number, number][], title: string, folder: string, margin: number, marginTpl: Tpl, hash?: string, sourceId?: string): Promise<Notebook> {
    const now = Date.now();
    const blobId = uid();
    const nb: Notebook = {
      id: uid(), title: title || 'Imported PDF', folder, fav: false,
      created: now, updated: now, pages: [], margin, marginTpl, tpl: 'blank', paper: PAPER_COLORS.white, importHash: hash, importSourceId: sourceId,
    };
    const pages: Page[] = sizes.map(([w, hh], i) => ({ id: uid(), nb: nb.id, w, h: hh, bg: { k: 'pdf', blob: blobId, n: i + 1 }, els: [] }));
    nb.pages = pages.map((p) => p.id);
    await db.putBlob(blobId, new Blob([data], { type: 'application/pdf' }));
    await db.putPages(pages);
    try { nb.cover = await makeCover(pages[0], nb); } catch { /* cover is optional */ }
    await db.putNotebook(nb);
    return nb;
  }

  async function importPdf(src: Src, destination?: string) {
    toast('Reading PDF…', true);
    let sizes: [number, number][];
    let data: ArrayBuffer;
    let hash: string;
    try {
      data = await src.data();
      hash = await pdfHash(data);
      const existing = notebooks.find((nb) => nb.importHash === hash);
      if (existing) { toast('This PDF is already imported.'); openNotebook(existing.id); return; }
      const { pdfPageSizes } = await import('./pdf');
      sizes = await pdfPageSizes(data);
      if (!sizes.length) throw new Error('PDF has no pages');
    } catch (e) {
      console.error(e);
      toast('This file could not be read as a PDF.');
      return;
    }
    document.querySelector('.toast')?.remove();
    const opt = await askMargin('Import PDF', sizes[0][0], sizes[0][1],
      `${sizes.length} ${sizes.length === 1 ? 'page' : 'pages'}. You can change the space later from the toolbar; your writing stays where it is.`,
      importTitle(src.name));
    if (!opt) return;
    const sourceFolder = importFolders([src])[0];
    const folder = destination === undefined ? sourceFolder || currentFolder() : joinFolder(destination, sourceFolder);
    const nb = await createPdfNotebook(data, sizes, opt.title, folder, opt.margin, opt.marginTpl, hash);
    if (folder && !folders.includes(folder)) { folders.push(folder); await db.putMeta('folders', folders); }
    await src.onImported?.();
    openNotebook(nb.id);
  }

  /** Imports many PDFs at once (several files, a folder, or a ZIP such as a GoodNotes export). */
  async function importMany(srcs: Src[], skipped: number, quick = false, automatic = false, destination?: string) {
    const folderNames = importFolders(srcs);
    const folderOf = (i: number) => destination === undefined ? folderNames[i] : joinFolder(destination, folderNames[i]);
    const nFolders = new Set(srcs.map((_, i) => folderOf(i)).filter(Boolean)).size;

    const opt = quick ? { margin: goodnotesMargin(), marginTpl: 'lined' as Tpl } : await askMargin(`Import ${srcs.length} PDFs`, 595, 842,
      `${srcs.length} notebooks will be created` + (nFolders ? `, sorted into ${nFolders} ${nFolders === 1 ? 'folder' : 'folders'} like in the export` : '') +
      '. The space applies to all of them and can be changed per notebook later.' +
      (skipped ? ` ${skipped} file${skipped === 1 ? '' : 's'} in GoodNotes' own format will be skipped; export those as PDF instead.` : ''));
    if (!opt) return;

    const { pdfPageSizes } = await import('./pdf');
    let ok = 0, failed = 0, duplicates = 0;
    for (let i = 0; i < srcs.length; i++) {
      if (disposed || (automatic && !autoEnabled())) break;
      toast(`Importing ${i + 1} of ${srcs.length}: ${srcs[i].name}`, true);
      if (quick) setImportStatus(`Importing Goodnotes export ${i + 1} of ${srcs.length}…`);
      try {
        const data = await srcs[i].data();
        const hash = await pdfHash(data);
        const sourceId = srcs[i].sourceId;
        const existing = notebooks.find((nb) => nb.importHash === hash && (!sourceId || !nb.importSourceId || nb.importSourceId === sourceId));
        if (existing) {
          const sourceFolder = folderOf(i);
          let changed = false;
          if (sourceId && !existing.importSourceId) { existing.importSourceId = sourceId; changed = true; }
          if (!existing.folderMoved && sourceFolder && sourceFolder !== 'Goodnotes' && (!existing.folder || existing.folder === 'Goodnotes')) {
            existing.folder = sourceFolder;
            changed = true;
            if (!folders.includes(sourceFolder)) { folders.push(sourceFolder); await db.putMeta('folders', folders); }
          }
          if (changed) { existing.updated = Date.now(); await db.putNotebook(existing); }
          duplicates++; await srcs[i].onImported?.(); continue;
        }
        const sizes = await pdfPageSizes(data);
        if (!sizes.length) throw new Error('PDF has no pages');
        const folder = folderOf(i) || (destination ?? currentFolder());
        const nb = await createPdfNotebook(data, sizes, importTitle(srcs[i].name), folder, opt.margin, opt.marginTpl, hash, sourceId);
        notebooks.push(nb);
        await srcs[i].onImported?.();
        if (folder && !folders.includes(folder)) { folders.push(folder); await db.putMeta('folders', folders); }
        ok++;
      } catch (e) { console.warn('Import failed for', srcs[i].name, e); failed++; }
      if (i % 3 === 2) { renderNavigation(); renderGrid(); }
    }
    renderNavigation(); renderGrid();
    pushSoon();
    const summary = `Imported ${ok} ${ok === 1 ? 'notebook' : 'notebooks'}` + (duplicates ? `, ${duplicates} already imported` : '') + (failed ? `, ${failed} could not be read` : '') + (skipped ? `, ${skipped} native Goodnotes files need PDF export` : '') + '.';
    if (quick) setImportStatus(summary + (autoEnabled() ? ' Checking for new exports automatically.' : ' Auto-import is paused.'));
    toast(summary);
  }

  /** Entry point for everything picked or dropped: PDFs, ZIPs of PDFs, folders, and Opplinotes backups. */
  async function importFiles(files: { file: File; path: string }[], quick = false, locked = false, destination?: string): Promise<void> {
    if (importing || scanning) { toast('An import is already running. Please wait for it to finish.'); return; }
    if (!locked && navigator.locks) {
      await navigator.locks.request('notesgood-import', { ifAvailable: true }, async (lock) => {
        if (lock) await importFiles(files, quick, true, destination);
        else toast('An import is running in another Opplinotes window. Please wait for it to finish.');
      });
      return;
    }
    importing = true;
    if (quick) document.querySelector<HTMLButtonElement>('.modal-actions .btn.primary')?.click();
    const srcs: Src[] = [];
    let skipped = 0, restored = 0, unreadable = 0;
    try {
      notebooks = await db.notebooks();
      const { isBackup, importBackup } = await import('./export');
      for (const { file, path } of files) {
        try {
          const lower = file.name.toLowerCase();
          const dir = path.split('/').slice(0, -1).join('/');
          if (await isBackup(file)) {
            toast('Restoring backup…', true);
            restored += await importBackup(file);
          } else if (/\.(pdf|zip|goodnotes)$/i.test(lower)) {
            if (lower.endsWith('.zip')) toast('Reading ' + file.name + '…', true);
            const result = await collectPdfSources(file, path);
            srcs.push(...result.sources); skipped += result.unsupported;
          } else if (file.type === 'application/pdf') srcs.push({ name: file.name, dir, data: () => file.arrayBuffer() });
        } catch (e) { console.warn('Could not read import', file.name, e); unreadable++; }
      }
      document.querySelector('.toast')?.remove();
      if (restored) {
        notebooks = await db.notebooks();
        const missing = [...new Set(notebooks.map((nb) => nb.folder))].filter((f) => f && !folders.includes(f));
        if (missing.length) { folders.push(...missing); await db.putMeta('folders', folders); }
        renderNavigation(); renderGrid();
        toast(`Restored ${restored} ${restored === 1 ? 'notebook' : 'notebooks'}.`);
      }
      if (srcs.length === 1 && !skipped && !quick) await importPdf(srcs[0], destination);
      else if (srcs.length) await importMany(srcs, skipped, quick, false, destination);
      else if (skipped) await modal({ title: 'These files need a PDF export', body: 'These are native Goodnotes documents. In Goodnotes Web, open each notebook → Share → Export as PDF. Save it to Downloads and the local Opplinotes app will pick it up automatically. On iPad or Mac you can also export selected folders as PDFs.', ok: 'OK', cancel: null });
      else if (!restored) toast('Nothing to import: choose PDFs, a ZIP of PDFs, or an Opplinotes backup.');
      if (unreadable) toast(`${unreadable} ${unreadable === 1 ? 'file could' : 'files could'} not be read. Other selected files were still imported.`);
    } catch (e: any) { console.error(e); toast('Import failed: ' + (e?.message ?? e)); }
    finally { importing = false; }
  }

  /** Files from a drop, walking into dropped folders. */
  async function droppedFiles(dt: DataTransfer): Promise<{ file: File; path: string }[]> {
    const out: { file: File; path: string }[] = [];
    const walk = async (entry: any, prefix: string): Promise<void> => {
      if (entry.isFile) out.push({ file: await new Promise<File>((res, rej) => entry.file(res, rej)), path: prefix + entry.name });
      else if (entry.isDirectory) {
        const reader = entry.createReader();
        for (;;) {
          const batch: any[] = await new Promise((res, rej) => reader.readEntries(res, rej));
          if (!batch.length) break;
          for (const en of batch) await walk(en, prefix + entry.name + '/');
        }
      }
    };
    const entries = [...dt.items].map((it) => (it as any).webkitGetAsEntry?.()).filter(Boolean);
    if (entries.length) for (const en of entries) await walk(en, '');
    else for (const f of dt.files) out.push({ file: f, path: f.name });
    return out;
  }

  void scanGoodnotes();
  return { importPdf: (file: File) => importFiles([{ file, path: file.name }]) };
}
