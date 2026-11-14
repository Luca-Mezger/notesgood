// Library: overview of all notebooks with folders, search, creation and PDF import.
import { db } from './db';
import { PAPER_COLORS } from './render';
import { makeCover } from './thumb';
import { uid, type Notebook, type Page, type Tpl } from './types';
import { confirmDlg, download, fmtDate, h, icon, iconBtn, menu, modal, promptText, toast, type MenuItem } from './ui';
import { markAllDirty, onSync, saveSyncConfig, sync, syncConfig, syncEnabled } from './sync';

const A4: [number, number] = [595, 842];
const TPLS: [Tpl, string][] = [['blank', 'Blank'], ['lined', 'Lined'], ['grid', 'Grid'], ['dots', 'Dotted']];

interface Src { name: string; dir: string; data: () => Promise<ArrayBuffer> }

type Filter = { k: 'all' } | { k: 'fav' } | { k: 'folder'; name: string };

export async function showLibrary(root: HTMLElement, openNotebook: (id: string) => void) {
  let notebooks = await db.notebooks();
  let folders = (await db.meta<string[]>('folders')) ?? [];
  let filter: Filter = { k: 'all' };
  let query = '';
  let sort = localStorage.getItem('margin.sort') ?? 'updated';

  const grid = h('div', { class: 'grid' });
  const chips = h('div', { class: 'chips' });
  const fileInput = h('input', {
    type: 'file', accept: 'application/pdf,.pdf,.zip,.notesgood,.margin', multiple: true, hidden: true,
    onchange: () => { const fs = [...(fileInput.files ?? [])]; fileInput.value = ''; if (fs.length) importFiles(fs.map((file) => ({ file, path: file.name }))); },
  });

  const dirInput = h('input', {
    type: 'file', webkitdirectory: true, multiple: true, hidden: true,
    onchange: () => { const fs = [...(dirInput.files ?? [])]; dirInput.value = ''; if (fs.length) importFiles(fs.map((file) => ({ file, path: file.webkitRelativePath || file.name }))); },
  });
  const syncBtn: HTMLButtonElement = h('button', { class: 'btn small syncbtn', type: 'button', title: 'Sync', onclick: () => syncDialog() }, icon('cloud', 18), h('span', null, 'Sync'));
  const offSync = onSync((s, msg) => {
    syncBtn.dataset.state = s;
    syncBtn.title = s === 'off' ? 'Sync is off. Click to set it up.' : msg;
    syncBtn.querySelector('span')!.textContent = s === 'off' ? 'Sync' : s === 'busy' ? 'Syncing…' : s === 'error' ? 'Sync error' : 'Synced';
  });
  const libMore: HTMLButtonElement = iconBtn('more', 'Backup options', () => menu(libMore, [
    { label: 'Sync settings…', icon: 'cloud', action: syncDialog },
    { label: 'Import from GoodNotes…', icon: 'import', action: goodnotesHelp },
    { label: 'Import a folder of PDFs…', icon: 'folder', action: () => dirInput.click() },
    { label: 'Back up all notebooks', icon: 'export', action: () => backup(notebooks, 'Notesgood backup ' + new Date().toISOString().slice(0, 10)) },
    { label: 'Restore from backup…', icon: 'import', action: () => fileInput.click() },
  ]));

  const view = h('div', { class: 'library' },
    h('header', { class: 'lib-head' },
      h('h1', null, 'Notesgood'),
      h('label', { class: 'search' }, icon('search', 18),
        h('input', { type: 'search', placeholder: 'Search notes', 'aria-label': 'Search notes', oninput: (e: Event) => { query = (e.target as HTMLInputElement).value.toLowerCase(); renderGrid(); } })),
      h('select', { class: 'field sort', 'aria-label': 'Sort by', onchange: (e: Event) => { sort = (e.target as HTMLSelectElement).value; localStorage.setItem('margin.sort', sort); renderGrid(); } },
        ...[['updated', 'Last edited'], ['title', 'Name'], ['created', 'Date created']].map(([v, l]) => h('option', { value: v, selected: v === sort }, l))),
      h('div', { class: 'lib-actions' },
        h('button', { class: 'btn', type: 'button', title: 'Import PDFs, a ZIP of PDFs, or a backup file', onclick: () => fileInput.click() }, icon('import', 18), 'Import'),
        h('button', { class: 'btn primary', type: 'button', onclick: newNotebook }, icon('plus', 18), 'New notebook'),
        syncBtn, libMore),
      fileInput, dirInput),
    chips, grid);

  // Drop a PDF anywhere on the library to import it
  view.addEventListener('dragover', (e) => { e.preventDefault(); view.classList.add('dropping'); });
  view.addEventListener('dragleave', () => view.classList.remove('dropping'));
  view.addEventListener('drop', (e) => {
    e.preventDefault();
    view.classList.remove('dropping');
    if (e.dataTransfer) droppedFiles(e.dataTransfer).then((fs) => { if (fs.length) importFiles(fs); });
  });

  root.replaceChildren(view);
  renderChips();
  renderGrid();

  // Sync whenever the library is shown, when the app comes back to the foreground, and every minute.
  const refreshAfterSync = async () => {
    if (!(await sync())) return;
    notebooks = await db.notebooks();
    const missing = [...new Set(notebooks.map((nb) => nb.folder))].filter((f) => f && !folders.includes(f));
    if (missing.length) { folders.push(...missing); await db.putMeta('folders', folders); }
    renderChips(); renderGrid();
  };
  if (syncEnabled()) refreshAfterSync();
  const timer = window.setInterval(() => { if (syncEnabled() && document.visibilityState === 'visible') refreshAfterSync(); }, 60000);
  const onVisible = () => { if (document.visibilityState === 'visible' && syncEnabled()) refreshAfterSync(); };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', onVisible);
  const mo = new MutationObserver(() => { if (!view.isConnected) { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('online', onVisible); offSync(); mo.disconnect(); } });
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
    const body = h('div', { class: 'form' },
      h('p', null, 'GoodNotes keeps notes in its own format, which only GoodNotes can read. It can export everything as PDF, and Notesgood imports that export in one go, folders included.'),
      h('ol', { class: 'steps' },
        h('li', null, 'In GoodNotes, open the Documents view and select the folders and notebooks you want (or all of them).'),
        h('li', null, 'Choose Export, pick PDF as the format, and save the ZIP file it produces.'),
        h('li', null, 'Get that ZIP onto this device and choose it here.')),
      h('p', { class: 'hint' }, 'Your handwriting arrives as part of each PDF page: it looks the same, and you can write on and beside it, but old strokes can no longer be erased or moved individually.'));
    if (await modal({ title: 'Import from GoodNotes', body, ok: 'Choose the ZIP…' })) fileInput.click();
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

  function renderChips() {
    const chip = (label: string, f: Filter, ic?: string) => {
      const active = f.k === filter.k && (f.k !== 'folder' || f.name === (filter as any).name);
      return h('button', { class: 'chip' + (active ? ' active' : ''), type: 'button', onclick: () => { filter = f; renderChips(); renderGrid(); } },
        ic ? icon(ic, 16) : null, label);
    };
    chips.replaceChildren(
      chip('All notes', { k: 'all' }),
      chip('Favourites', { k: 'fav' }, 'star'),
      ...folders.map((name) => {
        const c = chip(name, { k: 'folder', name }, 'folder');
        c.addEventListener('contextmenu', (e) => { e.preventDefault(); folderMenu(c, name); });
        if (filter.k === 'folder' && filter.name === name) c.append(h('span', { class: 'chip-more', title: 'Folder options', onclick: (e: Event) => { e.stopPropagation(); folderMenu(c, name); } }, icon('more', 16)));
        return c;
      }),
      h('button', { class: 'chip ghost', type: 'button', onclick: addFolder }, icon('plus', 16), 'Folder'));
  }

  async function addFolder() {
    const name = await promptText('New folder', '', 'Create');
    if (!name) return;
    if (!folders.includes(name)) { folders.push(name); await db.putMeta('folders', folders); }
    filter = { k: 'folder', name };
    renderChips(); renderGrid();
  }

  function folderMenu(anchor: HTMLElement, name: string) {
    menu(anchor, [
      { label: 'Rename folder', icon: 'pen', action: async () => {
        const next = await promptText('Rename folder', name);
        if (!next || next === name) return;
        folders = folders.map((f) => (f === name ? next : f));
        await db.putMeta('folders', folders);
        for (const nb of notebooks) if (nb.folder === name) { nb.folder = next; await db.putNotebook(nb); }
        pushSoon();
        filter = { k: 'folder', name: next };
        renderChips(); renderGrid();
      } },
      { label: 'Delete folder', icon: 'trash', danger: true, action: async () => {
        if (!(await confirmDlg(`Delete folder “${name}”?`, 'The notebooks inside are kept and move back to All notes.'))) return;
        folders = folders.filter((f) => f !== name);
        await db.putMeta('folders', folders);
        for (const nb of notebooks) if (nb.folder === name) { nb.folder = ''; await db.putNotebook(nb); }
        pushSoon();
        filter = { k: 'all' };
        renderChips(); renderGrid();
      } },
    ]);
  }

  function renderGrid() {
    let list = notebooks.filter((nb) =>
      (filter.k === 'all' || (filter.k === 'fav' ? nb.fav : nb.folder === filter.name)) &&
      (!query || nb.title.toLowerCase().includes(query)));
    list.sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title) : sort === 'created' ? b.created - a.created : b.updated - a.updated);

    if (!list.length) {
      grid.replaceChildren(h('div', { class: 'empty' },
        h('h2', null, query ? 'No notes match your search' : notebooks.length ? 'Nothing here yet' : 'Start your first notebook'),
        h('p', null, query ? 'Try a different title.' : 'Create a notebook, or import a PDF and choose how much writing space you want beside each page.')));
      return;
    }
    grid.replaceChildren(...list.map(card));
  }

  function card(nb: Notebook): HTMLElement {
    const more = iconBtn('more', 'Notebook options', (e) => { e.stopPropagation(); nbMenu(more, nb); }, 'card-more');
    return h('article', { class: 'card' },
      h('button', { class: 'cover', type: 'button', 'aria-label': 'Open ' + nb.title, onclick: () => openNotebook(nb.id) },
        nb.cover ? h('img', { src: nb.cover, alt: '', draggable: false }) : h('div', { class: 'cover-blank' })),
      h('div', { class: 'card-meta' },
        h('div', { class: 'card-text' },
          h('h3', { title: nb.title }, nb.fav ? h('span', { class: 'fav' }, '★ ') : null, nb.title),
          h('p', null, `${fmtDate(nb.updated)} · ${nb.pages.length} ${nb.pages.length === 1 ? 'page' : 'pages'}`)),
        more));
  }

  function nbMenu(anchor: HTMLElement, nb: Notebook) {
    const save = async () => { await db.putNotebook(nb); renderGrid(); pushSoon(); };
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
    const sel = h('select', { class: 'field' },
      h('option', { value: '' }, 'No folder'),
      ...folders.map((f) => h('option', { value: f, selected: f === nb.folder }, f)));
    if (!folders.length) { toast('Create a folder first with “+ Folder”.'); return; }
    if (await modal({ title: 'Move to folder', body: sel, ok: 'Move' })) { nb.folder = sel.value; await db.putNotebook(nb); renderGrid(); pushSoon(); }
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

  async function createPdfNotebook(data: ArrayBuffer, sizes: [number, number][], title: string, folder: string, margin: number, marginTpl: Tpl): Promise<Notebook> {
    const now = Date.now();
    const blobId = uid();
    const nb: Notebook = {
      id: uid(), title: title || 'Imported PDF', folder, fav: false,
      created: now, updated: now, pages: [], margin, marginTpl, tpl: 'blank', paper: PAPER_COLORS.white,
    };
    const pages: Page[] = sizes.map(([w, hh], i) => ({ id: uid(), nb: nb.id, w, h: hh, bg: { k: 'pdf', blob: blobId, n: i + 1 }, els: [] }));
    nb.pages = pages.map((p) => p.id);
    await db.putBlob(blobId, new Blob([data], { type: 'application/pdf' }));
    await db.putPages(pages);
    try { nb.cover = await makeCover(pages[0], nb); } catch { /* cover is optional */ }
    await db.putNotebook(nb);
    return nb;
  }

  async function importPdf(src: Src) {
    toast('Reading PDF…', true);
    let sizes: [number, number][];
    let data: ArrayBuffer;
    try {
      data = await src.data();
      const { pdfPageSizes } = await import('./pdf');
      sizes = await pdfPageSizes(data);
    } catch (e) {
      console.error(e);
      toast('This file could not be read as a PDF.');
      return;
    }
    document.querySelector('.toast')?.remove();
    const opt = await askMargin('Import PDF', sizes[0][0], sizes[0][1],
      `${sizes.length} ${sizes.length === 1 ? 'page' : 'pages'}. You can change the space later from the toolbar; your writing stays where it is.`,
      src.name.replace(/\.pdf$/i, ''));
    if (!opt) return;
    const nb = await createPdfNotebook(data, sizes, opt.title, currentFolder(), opt.margin, opt.marginTpl);
    openNotebook(nb.id);
  }

  /** Imports many PDFs at once (several files, a folder, or a ZIP such as a GoodNotes export). */
  async function importMany(srcs: Src[], skipped: number) {
    // Folder names: the directory path below whatever all files have in common.
    const split = srcs.map((s) => s.dir.split('/').filter(Boolean));
    let common = 0;
    while (split.every((d) => d.length > common && d[common] === split[0][common])) common++;
    const folderOf = (i: number) => split[i].slice(common).join(' / ');
    const nFolders = new Set(srcs.map((_, i) => folderOf(i)).filter(Boolean)).size;

    const opt = await askMargin(`Import ${srcs.length} PDFs`, 595, 842,
      `${srcs.length} notebooks will be created` + (nFolders ? `, sorted into ${nFolders} ${nFolders === 1 ? 'folder' : 'folders'} like in the export` : '') +
      '. The space applies to all of them and can be changed per notebook later.' +
      (skipped ? ` ${skipped} file${skipped === 1 ? '' : 's'} in GoodNotes' own format will be skipped; export those as PDF instead.` : ''));
    if (!opt) return;

    const { pdfPageSizes } = await import('./pdf');
    let ok = 0, failed = 0;
    for (let i = 0; i < srcs.length; i++) {
      toast(`Importing ${i + 1} of ${srcs.length}: ${srcs[i].name}`, true);
      try {
        const data = await srcs[i].data();
        const sizes = await pdfPageSizes(data);
        const folder = folderOf(i) || currentFolder();
        const nb = await createPdfNotebook(data, sizes, srcs[i].name.replace(/\.pdf$/i, ''), folder, opt.margin, opt.marginTpl);
        notebooks.push(nb);
        if (folder && !folders.includes(folder)) { folders.push(folder); await db.putMeta('folders', folders); }
        ok++;
      } catch (e) { console.warn('Import failed for', srcs[i].name, e); failed++; }
      if (i % 3 === 2) { renderChips(); renderGrid(); }
    }
    renderChips(); renderGrid();
    pushSoon();
    toast(`Imported ${ok} ${ok === 1 ? 'notebook' : 'notebooks'}` + (failed ? `, ${failed} could not be read` : '') + (skipped ? `, ${skipped} GoodNotes-format files skipped` : '') + '.');
  }

  /** Entry point for everything picked or dropped: PDFs, ZIPs of PDFs, folders, and Notesgood backups. */
  async function importFiles(files: { file: File; path: string }[]) {
    const srcs: Src[] = [];
    let skipped = 0, restored = 0;
    const { isBackup, importBackup } = await import('./export');
    try {
      for (const { file, path } of files) {
        const lower = file.name.toLowerCase();
        const dir = path.split('/').slice(0, -1).join('/');
        if (lower.endsWith('.goodnotes')) skipped++;
        else if (lower.endsWith('.zip')) {
          toast('Reading ' + file.name + '…', true);
          const { readZip } = await import('./unzip');
          for (const en of await readZip(file)) {
            const parts = en.name.split('/');
            const base = parts.pop()!;
            if (parts.includes('__MACOSX') || base.startsWith('.')) continue;
            if (/\.pdf$/i.test(base)) srcs.push({ name: base, dir: parts.join('/'), data: () => en.data() });
            else if (/\.goodnotes$/i.test(base)) skipped++;
          }
        } else if (await isBackup(file)) {
          toast('Restoring backup…', true);
          restored += await importBackup(file);
        } else if (lower.endsWith('.pdf') || file.type === 'application/pdf') srcs.push({ name: file.name, dir, data: () => file.arrayBuffer() });
      }
    } catch (e: any) {
      console.error(e);
      toast('Could not read that file: ' + (e?.message ?? e));
      return;
    }
    document.querySelector('.toast')?.remove();
    if (restored) {
      notebooks = await db.notebooks();
      const missing = [...new Set(notebooks.map((nb) => nb.folder))].filter((f) => f && !folders.includes(f));
      if (missing.length) { folders.push(...missing); await db.putMeta('folders', folders); }
      renderChips(); renderGrid();
      toast(`Restored ${restored} ${restored === 1 ? 'notebook' : 'notebooks'}.`);
    }
    if (srcs.length === 1 && !skipped) await importPdf(srcs[0]);
    else if (srcs.length) await importMany(srcs, skipped);
    else if (skipped) toast('Those are files in GoodNotes’ own format, which only GoodNotes can read. In GoodNotes, export your folders as PDF and import the ZIP it produces.');
    else if (!restored) toast('Nothing to import: choose PDFs, a ZIP of PDFs, or a Notesgood backup.');
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

  return { importPdf: (file: File) => importFiles([{ file, path: file.name }]) };
}
