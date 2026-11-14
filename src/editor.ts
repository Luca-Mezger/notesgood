// The notebook editor: page layout, zoom/pan, stylus input, tools, undo, autosave.
import { db } from './db';
import { richHtml, SNIPPETS, texError, texHtml } from './latex';
import { closeDocs, clearTextLines, pdfTextLines, renderPdfPage, type RenderJob, type TextLine } from './pdf';
import {
  axisSnap, cacheImage, cloneEl, drawEls, drawImages, drawInk, drawPaper, drawShape, drawStroke, elBBox, elInPoly, eraseFromStroke, hitEl, makeStroke,
  onImageReady, PAPER_COLORS, polyStroke, recognize, shapeToStroke, unionBBox, xformEl, type Snap,
} from './render';
import { makeCover, renderThumb } from './thumb';
import { pageH, pageW, uid, type El, type ImageEl, type Notebook, type Page, type ShapeKind, type TexEl, type TextEl, type Tpl } from './types';
import { confirmDlg, download, h, icon, iconBtn, menu, popover, toast } from './ui';
import { sync, syncEnabled } from './sync';
import { inkToPng, recogReady, recognize as recogInk, RECOG_MODELS, recogConfig, saveRecogConfig } from './recognize';
import { applyTheme, themeSetting, setThemeSetting } from './theme';

export interface EditorHandle { close(): Promise<void> }

type Tool = 'pen' | 'hl' | 'eraser' | 'shape' | 'text' | 'tex' | 'select' | 'hand';

interface Settings {
  tool: Tool;
  pen: { c: string; s: number };
  hl: { c: string; s: number; mode?: 'mark' | 'under'; straight?: boolean };
  /** Underline: a thin, opaque, always-straight line. */
  ul: { c: string; s: number };
  eraser: { s: number; mode?: 'stroke' | 'partial' };
  shape: { c: string; s: number; k: ShapeKind };
  text: { c: string; fs: number };
  tex: { c: string; fs: number };
  /** Whether a finger draws (true) or only scrolls (false). Switches off automatically once a stylus is seen. */
  fingerDraw: boolean;
  penSeen: boolean;
  sidebar: boolean;
  /** Stroke width follows stylus pressure. */
  pressure: boolean;
  /** Holding the pen still at the end of a stroke turns it into a clean line or shape. */
  holdSnap: boolean;
  holdMs: number;
  /** Underlines and straight highlights on PDF pages snap to the printed text lines. */
  textSnap: boolean;
  toolbar: 'top' | 'left';
  /** 0 = raw input, 1 = heavy smoothing of pen strokes. */
  smooth: number;
  /** PDF pages grow downward when you write near their bottom edge. */
  grow: boolean;
  snapGrid: boolean;
}

const DEFAULTS: Settings = {
  tool: 'pen',
  pen: { c: '#1b1b1f', s: 2 },
  hl: { c: '#ffd60a', s: 16, mode: 'mark', straight: false },
  ul: { c: '#d92d20', s: 1.6 },
  eraser: { s: 14, mode: 'stroke' },
  shape: { c: '#1f4fd8', s: 2, k: 'line' },
  text: { c: '#1b1b1f', fs: 14 },
  tex: { c: '#1b1b1f', fs: 16 },
  fingerDraw: true,
  penSeen: false,
  sidebar: false,
  pressure: true,
  holdSnap: true,
  holdMs: 450,
  textSnap: true,
  toolbar: 'top',
  smooth: 0.25,
  grow: true,
  snapGrid: false,
};

const INK = ['#1b1b1f', '#1f4fd8', '#d92d20', '#16803c', '#e8770c', '#7a3fd1'];
const HL = ['#ffd60a', '#7ee081', '#ff8fb1', '#7cc4ff', '#ffb347'];
const SIZES: Record<string, { presets: number[]; min: number; max: number; step: number }> = {
  pen: { presets: [1.2, 2, 3.5], min: 0.5, max: 8, step: 0.1 },
  hl: { presets: [10, 16, 24], min: 6, max: 36, step: 1 },
  shape: { presets: [1.2, 2, 3.5], min: 0.5, max: 8, step: 0.1 },
  eraser: { presets: [8, 14, 26], min: 4, max: 40, step: 1 },
};
const TOOLS: [Tool, string, string, string][] = [
  ['pen', 'pen', 'Pen', 'P'], ['hl', 'hl', 'Highlighter', 'H'], ['eraser', 'eraser', 'Eraser', 'E'],
  ['shape', 'shape', 'Shapes', 'S'], ['text', 'text', 'Text', 'T'], ['tex', 'tex', 'LaTeX', 'M'],
  ['select', 'lasso', 'Lasso select', 'L'], ['hand', 'hand', 'Move around', 'V'],
];

const MIN_ZOOM = 0.08, MAX_ZOOM = 6;
/** Upper bound for one canvas's backing store, in pixels. Beyond this pages render slightly soft. */
const MAX_PX = ((navigator as any).deviceMemory ?? 4) >= 8 ? 16e6 : 9e6;

/** Lasso selection copied with Ctrl+C; survives switching notebooks. */
let clipboard: El[] = [];

interface PV {
  page: Page; el: HTMLDivElement; bg: HTMLCanvasElement; pics: HTMLCanvasElement; ink: HTMLCanvasElement; objs: HTMLDivElement;
  visible: boolean; scale: number; bgScale: number; pdfS: number; bgW: number; job: RenderJob | null;
  nodes: Map<string, HTMLElement>; built: boolean; lines: TextLine[] | null;
}
interface Op { page: Page; removed: [number, El][]; added: [number, El][] }

type Action =
  | { k: 'draw'; id: number; pv: PV; tool: 'pen' | 'hl'; c: string; s: number; baseS: number; pts: number[]; drawn: number; lp: number; straight: boolean; snap: Snap | null; hx: number; hy: number; timer: number; ruler: boolean }
  | { k: 'erase'; id: number; pv: PV; orig: El[]; removed: [number, El][]; added: El[]; dirty: boolean; lx: number; ly: number }
  | { k: 'ruler'; id: number; pv: PV; part: 'a' | 'b' | 'body'; sx: number; sy: number; o: { x1: number; y1: number; x2: number; y2: number } }
  | { k: 'shape'; id: number; pv: PV; x1: number; y1: number; x2: number; y2: number }
  | { k: 'lasso'; id: number; pv: PV; pts: number[] }
  | { k: 'xform'; id: number; pv: PV; mode: 'move' | 'scale' | 'rotate'; x0: number; y0: number; origs: El[]; ox: number; oy: number; d0: number; moved: boolean }
  | { k: 'pan'; id: number; x: number; y: number };

export async function openEditor(root: HTMLElement, nbId: string, onExit: () => void): Promise<EditorHandle> {
  const nbLoaded = await db.notebook(nbId);
  if (!nbLoaded) throw new Error('Notebook not found');
  const nb: Notebook = nbLoaded;
  const byId = new Map((await db.pages(nbId)).map((p) => [p.id, p]));
  let pages: Page[] = nb.pages.map((id) => byId.get(id)).filter((p): p is Page => !!p);
  if (!pages.length) throw new Error('Notebook has no pages');

  const ts: Settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('margin.tools') ?? '{}') };
  const saveSettings = () => localStorage.setItem('margin.tools', JSON.stringify(ts));

  let zoom = 1;
  let dpr = window.devicePixelRatio || 1;
  let pvs: PV[] = [];
  const pvOf = new Map<Page, PV>();
  let curIdx = 0;
  let act: Action | null = null;
  let sel: { pv: PV; els: El[] } | null = null;
  let editing: { finish: () => void } | null = null;
  const undo: Op[] = [], redo: Op[] = [];
  const dirty = new Set<Page>();
  const thumbDirty = new Set<Page>();
  let saveTimer = 0, zoomTimer = 0, closed = false;

  // ---------- DOM ----------
  const pagesEl = h('div', { class: 'pages' });
  const viewport = h('div', { class: 'viewport' }, pagesEl);
  const live = h('canvas', { class: 'live' });
  const lctx = live.getContext('2d', { desynchronized: true })!;
  const selBox = h('div', { class: 'selbox' }, h('div', { class: 'selhandle' }), h('div', { class: 'selrot' }));
  const rulerEl = h('div', { class: 'ruler' }, h('div', { class: 'rh a' }), h('div', { class: 'rh b' }));
  let ruler: { pv: PV; x1: number; y1: number; x2: number; y2: number } | null = null;
  const thumbsList = h('div', { class: 'thumb-list' });
  const pageLabel = h('span', { class: 'page-label' });
  const thumbs = h('aside', { class: 'thumbs' },
    h('div', { class: 'thumb-actions' },
      iconBtn('plus', 'Add page after this one', () => addPage()),
      iconBtn('up', 'Move page up', () => movePage(-1)),
      iconBtn('down', 'Move page down', () => movePage(1)),
      iconBtn('trash', 'Delete page', () => deletePage())),
    thumbsList);
  const stage = h('div', { class: 'stage' }, viewport, live);
  const toolRow = h('div', { class: 'tools' });
  const optbar = h('div', { class: 'optbar' });
  const undoBtn = iconBtn('undo', 'Undo (Ctrl+Z)', () => doUndo());
  const redoBtn = iconBtn('redo', 'Redo (Ctrl+Shift+Z)', () => doRedo());
  const zoomBtn = h('button', { class: 'btn small zoom', type: 'button', title: 'Fit page to width', onclick: () => { setZoom(fitZoom(false), 0, 0, true); } });
  const fingerBtn = iconBtn('finger', '', () => { ts.fingerDraw = !ts.fingerDraw; saveSettings(); syncToggles(); toast(ts.fingerDraw ? 'Finger draws. Use two fingers to scroll and zoom.' : 'Finger scrolls. Only the stylus and mouse draw.'); });
  const sideBtn = iconBtn('pages', 'Pages', () => { ts.sidebar = !ts.sidebar; saveSettings(); syncToggles(); });
  const marginBtn = iconBtn('margin', 'Writing space beside PDF pages', () => marginPopover());
  const exportBtn: HTMLButtonElement = iconBtn('export', 'Export', () => menu(exportBtn, [
    { label: 'Export as PDF', icon: 'pdf', action: async () => {
      try {
        editing?.finish();
        await flush();
        toast('Preparing PDF…', true);
        const { exportPdf, safeName } = await import('./export');
        download(await exportPdf(nb, pages, (d, t) => toast(`Preparing PDF… page ${d} of ${t}`, true)), safeName(nb.title) + '.pdf');
        toast('PDF saved to your downloads.');
      } catch (e: any) { console.error(e); toast('Export failed: ' + (e?.message ?? e)); }
    } },
    { label: 'Save backup file', icon: 'export', action: async () => {
      try {
        editing?.finish();
        await flush();
        const { exportBackup, safeName } = await import('./export');
        download(await exportBackup([nb]), safeName(nb.title) + '.notesgood');
        toast('Backup saved to your downloads.');
      } catch (e: any) { console.error(e); toast('Backup failed: ' + (e?.message ?? e)); }
    } },
  ]));
  const imgInput = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: () => { const f = imgInput.files?.[0]; imgInput.value = ''; if (f) addImage(f); } });
  const imgBtn = iconBtn('image', 'Insert picture (or paste one with Ctrl+V)', () => imgInput.click());
  const rulerBtn = iconBtn('ruler', 'Ruler (R)', () => toggleRuler());
  const settingsBtn: HTMLButtonElement = iconBtn('sliders', 'Settings', () => settingsPopover());
  const titleInput = h('input', {
    class: 'title', value: nb.title, 'aria-label': 'Notebook title', spellcheck: false,
    onchange: () => { nb.title = titleInput.value.trim() || 'Untitled notebook'; titleInput.value = nb.title; touchNb(); },
    onkeydown: (e: KeyboardEvent) => { e.stopPropagation(); if (e.key === 'Enter') titleInput.blur(); },
  });
  const hasPdf = () => pages.some((p) => p.bg.k === 'pdf');

  const toolbarEl = h('div', { class: 'toolbar' },
      iconBtn('back', 'Back to library', () => onExit()),
      titleInput,
      h('div', { class: 'tb-group' }, undoBtn, redoBtn),
      toolRow,
      imgBtn, rulerBtn, imgInput,
      h('div', { class: 'tb-group right' }, pageLabel, zoomBtn, fingerBtn, hasPdf() ? marginBtn : null, settingsBtn, exportBtn, sideBtn));
  const view = h('div', { class: 'editor' },
    toolbarEl,
    optbar,
    h('div', { class: 'work' }, thumbs, stage));
  root.replaceChildren(view);

  // ---------- pages & rendering ----------
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      const pv = pvs[Number((en.target as HTMLElement).dataset.i)];
      if (!pv || pv.el !== en.target) continue;
      pv.visible = en.isIntersecting;
      if (pv.visible) renderPV(pv); else releasePV(pv);
    }
  }, { root: viewport, rootMargin: '60% 0px' });

  const thumbIo = new IntersectionObserver((entries) => {
    for (const en of entries) {
      const t = en.target as HTMLElement;
      if (en.isIntersecting && !t.dataset.done) { t.dataset.done = '1'; paintThumb(Number(t.dataset.i)); }
    }
  }, { root: thumbsList, rootMargin: '300px 0px' });

  function buildPages() {
    io.disconnect();
    thumbIo.disconnect();
    for (const pv of pvs) pv.job?.cancel();
    pvOf.clear();
    selBox.remove();
    sel = null;
    pvs = pages.map((page, i) => {
      const bg = h('canvas', { class: 'bg' }), pics = h('canvas', { class: 'pics' }), ink = h('canvas', { class: 'ink' }), objs = h('div', { class: 'objs' });
      const el = h('div', { class: 'page', 'data-i': i }, bg, pics, ink, objs);
      const pv: PV = { page, el, bg, pics, ink, objs, visible: false, scale: 0, bgScale: 0, pdfS: 0, bgW: 0, job: null, nodes: new Map(), built: false, lines: null };
      sizePV(pv);
      pvOf.set(page, pv);
      return pv;
    });
    pagesEl.replaceChildren(...pvs.map((p) => p.el));
    for (const pv of pvs) io.observe(pv.el);

    thumbsList.replaceChildren(...pages.map((_, i) => {
      const t = h('button', { class: 'thumb', type: 'button', 'data-i': i, onclick: () => scrollToPage(i) },
        h('canvas'), h('span', null, String(i + 1)));
      thumbIo.observe(t);
      return t;
    }));
    updateCurrent();
  }

  function sizePV(pv: PV) {
    pv.el.style.setProperty('--w', String(pageW(pv.page, nb)));
    pv.el.style.setProperty('--h', String(pageH(pv.page)));
    pv.objs.style.width = pageW(pv.page, nb) + 'px';
    pv.objs.style.height = pageH(pv.page) + 'px';
  }

  function renderPV(pv: PV) {
    const w = pageW(pv.page, nb), hh = pageH(pv.page);
    const s = Math.min(zoom * dpr, Math.sqrt(MAX_PX / (w * hh)));
    const cw = Math.round(w * s), ch = Math.round(hh * s);
    if (pv.ink.width !== cw || pv.ink.height !== ch) { pv.ink.width = cw; pv.ink.height = ch; pv.pics.width = cw; pv.pics.height = ch; }
    pv.scale = s;
    redrawInk(pv);
    renderBg(pv, s);
    if (!pv.built) buildObjs(pv);
    if (pv.page.bg.k === 'pdf' && !pv.lines && ts.textSnap) {
      pv.lines = [];
      pdfTextLines(pv.page.bg.blob, pv.page.bg.n).then((l) => { pv.lines = l; }).catch(() => {});
    }
  }

  function releasePV(pv: PV) {
    if (act && 'pv' in act && act.pv === pv) return;
    pv.job?.cancel();
    pv.job = null;
    pv.bg.width = pv.bg.height = pv.ink.width = pv.ink.height = pv.pics.width = pv.pics.height = 0;
    pv.scale = pv.bgScale = pv.pdfS = 0;
  }

  function redrawInk(pv: PV) {
    if (!pv.scale) return;
    const c = pv.ink.getContext('2d')!;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, pv.ink.width, pv.ink.height);
    c.setTransform(pv.scale, 0, 0, pv.scale, 0, 0);
    drawInk(c, pv.page.els);
    const pc = pv.pics.getContext('2d')!;
    pc.setTransform(1, 0, 0, 1, 0, 0);
    pc.clearRect(0, 0, pv.pics.width, pv.pics.height);
    if (pv.page.els.some((e) => e.t === 'i')) { pc.setTransform(pv.scale, 0, 0, pv.scale, 0, 0); drawImages(pc, pv.page.els); }
  }

  function renderBg(pv: PV, s: number) {
    pv.job?.cancel();
    pv.job = null;
    const page = pv.page, w = pageW(page, nb);
    const paint = (pdf: CanvasImageSource | null, pdfW = 0, pdfH = 0, final = false) => {
      const H = pageH(page);
      const cw = Math.round(w * s), ch = Math.round(H * s);
      if (pv.bg.width !== cw || pv.bg.height !== ch) { pv.bg.width = cw; pv.bg.height = ch; }
      const c = pv.bg.getContext('2d')!;
      c.setTransform(s, 0, 0, s, 0, 0);
      if (page.bg.k === 'paper') drawPaper(c, 0, 0, w, H, page.bg.tpl, page.bg.color);
      else {
        drawPaper(c, 0, 0, w, H, nb.marginTpl, PAPER_COLORS.white);
        c.fillStyle = '#fff';
        c.fillRect(0, 0, page.w, page.h);
        c.fillStyle = 'rgba(0,0,0,0.13)';
        if (w > page.w) c.fillRect(page.w - 0.3, 0, 0.6, H);
        if (H > page.h) c.fillRect(0, page.h - 0.3, page.w, 0.6);
        if (pdf) c.drawImage(pdf, 0, 0, pdfW, pdfH, 0, 0, page.w, page.h);
      }
      pv.bgScale = s;
      pv.pdfS = final ? s : 0;
      pv.bgW = w;
    };
    if (page.bg.k === 'paper') { paint(null); return; }
    if (!pv.bgScale) paint(null);
    else if (pv.bgW !== w || pv.bg.height !== Math.round(pageH(page) * pv.bgScale)) {
      // Page width changed (margin slider): keep the already rendered PDF as a placeholder.
      const sw = Math.round(page.w * pv.bgScale), sh = Math.round(page.h * pv.bgScale);
      const tmp = h('canvas', { width: sw, height: sh });
      tmp.getContext('2d')!.drawImage(pv.bg, 0, 0);
      paint(tmp, sw, sh);
    } else if (pv.pdfS === s) return; // already crisp
    const job = renderPdfPage(page.bg.blob, page.bg.n, s);
    pv.job = job;
    job.promise.then((canvas) => {
      if (pv.job !== job) return;
      pv.job = null;
      if (canvas) paint(canvas, canvas.width, canvas.height, true);
    });
  }

  // Text and LaTeX elements are DOM nodes laid out in page units and scaled with the page.
  function buildObjs(pv: PV) {
    pv.built = true;
    pv.nodes.clear();
    pv.objs.replaceChildren();
    for (const e of pv.page.els) if (e.t === 't' || e.t === 'x') makeNode(pv, e);
  }
  function makeNode(pv: PV, e: TextEl | TexEl): HTMLElement {
    const n = h('div', { class: 'obj ' + (e.t === 't' ? 'txt' : 'tex') });
    pv.objs.append(n);
    pv.nodes.set(e.id, n);
    fillNode(pv, e);
    return n;
  }
  function fillNode(pv: PV, e: TextEl | TexEl) {
    const n = pv.nodes.get(e.id);
    if (!n) return;
    n.innerHTML = e.t === 't' ? richHtml(e.text) : texHtml(e.src, true);
    placeNode(pv, e);
    e.w = n.offsetWidth;
    e.h = n.offsetHeight;
  }
  function placeNode(pv: PV, e: TextEl | TexEl) {
    const n = pv.nodes.get(e.id);
    if (!n) return;
    n.style.left = e.x + 'px';
    n.style.top = e.y + 'px';
    n.style.fontSize = e.fs + 'px';
    n.style.color = e.c;
    if (e.t === 't') n.style.maxWidth = Math.max(60, pageW(pv.page, nb) - e.x - 6) + 'px';
  }
  function measure(pv: PV) {
    for (const e of pv.page.els) if (e.t === 't' || e.t === 'x') {
      const n = pv.nodes.get(e.id);
      if (n) { e.w = n.offsetWidth; e.h = n.offsetHeight; }
    }
  }

  /** Redraws everything about a page after its elements changed. */
  function refreshPage(pv: PV) {
    redrawInk(pv);
    if (pv.built) buildObjs(pv);
    markDirty(pv.page);
  }

  // ---------- thumbnails ----------
  function paintThumb(i: number) {
    const t = thumbsList.children[i] as HTMLElement | undefined;
    if (!t || !pages[i]) return;
    renderThumb(t.querySelector('canvas')!, pages[i], nb, 132 * Math.min(dpr, 2));
  }

  function updateCurrent() {
    // Page under a line 40% down the viewport (binary search over page offsets).
    const mid = viewport.scrollTop + viewport.clientHeight * 0.4;
    let lo = 0, hi = pvs.length - 1;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      const el = pvs[m].el;
      if (el.offsetTop + el.offsetHeight < mid) lo = m + 1; else hi = m;
    }
    if (lo !== curIdx || !thumbsList.querySelector('.current')) {
      thumbsList.querySelector('.current')?.classList.remove('current');
      curIdx = lo;
      const t = thumbsList.children[curIdx] as HTMLElement | undefined;
      t?.classList.add('current');
      if (ts.sidebar) t?.scrollIntoView({ block: 'nearest' });
    }
    pageLabel.textContent = `${curIdx + 1} / ${pages.length}`;
  }

  function scrollToPage(i: number) {
    const pv = pvs[Math.max(0, Math.min(pvs.length - 1, i))];
    if (!pv) return;
    viewport.scrollTop += pv.el.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 12;
    updateCurrent();
  }

  // ---------- zoom ----------
  function fitZoom(initial: boolean): number {
    // On opening, show the PDF page plus at most one page-width of margin; very wide margins are reached by panning.
    const maxW = Math.max(...pages.map((p) => (initial && p.bg.k === 'pdf' ? Math.min(pageW(p, nb), p.w * 2) : pageW(p, nb))));
    const fit = (viewport.clientWidth - 28) / maxW;
    return Math.max(MIN_ZOOM, Math.min(initial ? 1.7 : MAX_ZOOM, fit));
  }

  /** Sets the zoom, keeping the page point under client position (ax, ay) fixed. */
  function setZoom(z: number, ax: number, ay: number, center = false) {
    z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
    if (z === zoom) return;
    const vr = viewport.getBoundingClientRect();
    if (center) { ax = vr.left + vr.width / 2; ay = vr.top + vr.height * 0.4; }
    let pv = pvs[curIdx];
    for (const p of pvs) {
      if (!p.visible) continue;
      const r = p.el.getBoundingClientRect();
      if (ay >= r.top && ay <= r.bottom + 14 * zoom) { pv = p; break; }
    }
    const r = pv.el.getBoundingClientRect();
    const fx = (ax - r.left) / zoom, fy = (ay - r.top) / zoom;
    zoom = z;
    pagesEl.style.setProperty('--z', String(z));
    const r2 = pv.el.getBoundingClientRect();
    viewport.scrollLeft += r2.left + fx * z - ax;
    viewport.scrollTop += r2.top + fy * z - ay;
    zoomBtn.textContent = Math.round(z * 100) + '%';
    updateSelBox();
    clearTimeout(zoomTimer);
    zoomTimer = window.setTimeout(() => { for (const p of pvs) if (p.visible) renderPV(p); }, 140);
  }

  // ---------- live overlay ----------
  let liveClear = 0;
  function sizeLive() {
    dpr = window.devicePixelRatio || 1;
    live.width = Math.round(stage.clientWidth * dpr);
    live.height = Math.round(stage.clientHeight * dpr);
  }
  function clearLive() {
    cancelAnimationFrame(liveClear);
    liveClear = 0;
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.clearRect(0, 0, live.width, live.height);
  }
  /** Clears the overlay on the next frame, so the committed stroke is on screen before the live one goes. */
  function clearLiveSoon() {
    cancelAnimationFrame(liveClear);
    liveClear = requestAnimationFrame(clearLive);
  }
  /** Points the overlay's coordinate system at a page, so page coordinates can be drawn directly. */
  function aimLive(pv: PV) {
    const pr = pv.el.getBoundingClientRect(), sr = stage.getBoundingClientRect();
    lctx.setTransform(zoom * dpr, 0, 0, zoom * dpr, (pr.left - sr.left) * dpr, (pr.top - sr.top) * dpr);
  }

  // ---------- persistence & undo ----------
  function markDirty(page: Page) {
    dirty.add(page);
    thumbDirty.add(page);
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(flush, 600);
  }
  function touchNb() {
    nb.updated = Date.now();
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(flush, 600);
  }
  async function flush() {
    clearTimeout(saveTimer);
    const list = [...dirty];
    dirty.clear();
    if (list.length) nb.updated = Date.now();
    try {
      if (list.length) await db.putPages(list);
      await db.putNotebook(nb);
    } catch (e) {
      console.error(e);
      for (const p of list) dirty.add(p);
      toast('Could not save. Your device may be out of storage.');
    }
    for (const p of thumbDirty) {
      const i = pages.indexOf(p);
      const t = thumbsList.children[i] as HTMLElement | undefined;
      if (t?.dataset.done) paintThumb(i);
    }
    thumbDirty.clear();
  }

  function pushOp(op: Op) {
    undo.push(op);
    if (undo.length > 300) undo.shift();
    redo.length = 0;
    markDirty(op.page);
    syncUndo();
  }
  function applyOp(op: Op, inverse: boolean) {
    const els = op.page.els;
    const rem = inverse ? op.added : op.removed, add = inverse ? op.removed : op.added;
    for (const [, e] of rem) { const i = els.indexOf(e); if (i >= 0) els.splice(i, 1); }
    for (const [i, e] of [...add].sort((a, b) => a[0] - b[0])) els.splice(Math.min(i, els.length), 0, e);
    setSel(null);
    const pv = pvOf.get(op.page);
    if (pv) {
      refreshPage(pv);
      if (!pv.visible) scrollToPage(pvs.indexOf(pv));
    }
    syncUndo();
  }
  function doUndo() { editing?.finish(); const op = undo.pop(); if (op) { redo.push(op); applyOp(op, true); } }
  function doRedo() { editing?.finish(); const op = redo.pop(); if (op) { undo.push(op); applyOp(op, false); } }
  function syncUndo() { undoBtn.disabled = !undo.length; redoBtn.disabled = !redo.length; }

  // ---------- selection ----------
  function setSel(s: typeof sel) {
    sel = s && s.els.length ? s : null;
    updateSelBox();
    if (ts.tool === 'select') renderOptbar();
  }
  function updateSelBox() {
    updateRuler();
    const bb = sel && unionBBox(sel.els);
    if (!sel || !bb) { selBox.remove(); return; }
    if (selBox.parentElement !== sel.pv.el) sel.pv.el.append(selBox);
    const pad = 5;
    selBox.style.left = bb[0] * zoom - pad + 'px';
    selBox.style.top = bb[1] * zoom - pad + 'px';
    selBox.style.width = (bb[2] - bb[0]) * zoom + pad * 2 + 'px';
    selBox.style.height = (bb[3] - bb[1]) * zoom + pad * 2 + 'px';
  }
  function deleteSel() {
    if (!sel) return;
    const { pv, els } = sel, all = pv.page.els;
    const removed = els.map((e) => [all.indexOf(e), e] as [number, El]);
    pv.page.els = all.filter((e) => !els.includes(e));
    setSel(null);
    refreshPage(pv);
    pushOp({ page: pv.page, removed, added: [] });
  }
  function duplicateSel() {
    if (!sel) return;
    const { pv } = sel;
    const copies = sel.els.map((e) => { const c = cloneEl(e, true); xformEl(e, c, 14, 14); return c; });
    const start = pv.page.els.length;
    pv.page.els.push(...copies);
    refreshPage(pv);
    pushOp({ page: pv.page, removed: [], added: copies.map((c, i) => [start + i, c]) });
    setSel({ pv, els: copies });
  }
  function recolorSel(c: string) {
    if (!sel) return;
    const { pv, els } = sel, all = pv.page.els;
    const removed = els.map((e) => [all.indexOf(e), cloneEl(e)] as [number, El]);
    for (const e of els) if (e.t !== 'i') e.c = c;
    refreshPage(pv);
    pushOp({ page: pv.page, removed, added: els.map((e) => [all.indexOf(e), e]) });
  }

  // ---------- text & LaTeX ----------
  function editText(pv: PV, existing: TextEl | null, x: number, y: number) {
    const isNew = !existing;
    const el: TextEl = existing ?? { t: 't', id: uid(), x, y: y - ts.text.fs * 0.7, c: ts.text.c, fs: ts.text.fs, text: '' };
    const before = cloneEl(el);
    const n = pv.nodes.get(el.id) ?? makeNode(pv, el);
    n.textContent = el.text;
    try { n.contentEditable = 'plaintext-only'; } catch { n.contentEditable = 'true'; }
    n.classList.add('editing');
    n.spellcheck = false;
    const stop = (e: Event) => e.stopPropagation();
    const onKey = (e: KeyboardEvent) => { e.stopPropagation(); if (e.key === 'Escape') n.blur(); };
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      editing = null;
      n.removeEventListener('keydown', onKey);
      n.removeEventListener('blur', finish);
      n.contentEditable = 'false';
      n.classList.remove('editing');
      const text = n.innerText.replace(/ /g, ' ').replace(/\s+$/, '');
      const all = pv.page.els;
      if (!text) {
        n.remove();
        pv.nodes.delete(el.id);
        if (!isNew) { const i = all.indexOf(el); all.splice(i, 1); pushOp({ page: pv.page, removed: [[i, el]], added: [] }); }
        return;
      }
      el.text = text;
      fillNode(pv, el);
      if (isNew) { all.push(el); pushOp({ page: pv.page, removed: [], added: [[all.length - 1, el]] }); }
      else if (text !== before.text) { const i = all.indexOf(el); pushOp({ page: pv.page, removed: [[i, before]], added: [[i, el]] }); }
    };
    n.addEventListener('keydown', onKey);
    n.addEventListener('keyup', stop);
    n.addEventListener('blur', finish);
    editing = { finish };
    setTimeout(() => {
      n.focus();
      const r = document.createRange();
      r.selectNodeContents(n);
      r.collapse(false);
      const s = getSelection();
      s?.removeAllRanges();
      s?.addRange(r);
    });
  }

  let texPanel: HTMLElement | null = null;
  function closeTex() { texPanel?.remove(); texPanel = null; editing = null; }
  function editTex(pv: PV, existing: TexEl | null, x: number, y: number) {
    closeTex();
    const ta = h('textarea', { class: 'field tex-src', rows: 3, placeholder: 'e.g.  \\int_0^1 x^2\\,dx = \\frac{1}{3}', spellcheck: false, autocapitalize: 'off', autocomplete: 'off', value: existing?.src ?? '' });
    const preview = h('div', { class: 'tex-preview' });
    const err = h('div', { class: 'tex-err' });
    const update = () => {
      const src = ta.value.trim();
      preview.innerHTML = src ? texHtml(src, true) : '<span class="muted">Preview</span>';
      err.textContent = src ? texError(src) ?? '' : '';
    };
    const insert = (s: string, back = 0) => {
      const a = ta.selectionStart, b = ta.selectionEnd;
      ta.setRangeText(s, a, b, 'end');
      ta.selectionStart = ta.selectionEnd = a + s.length - back;
      ta.focus();
      update();
    };
    const commit = () => {
      const src = ta.value.trim();
      const all = pv.page.els;
      if (existing) {
        const i = all.indexOf(existing);
        if (i < 0) { closeTex(); return; }
        if (!src) { all.splice(i, 1); pushOp({ page: pv.page, removed: [[i, existing]], added: [] }); refreshPage(pv); }
        else if (src !== existing.src) {
          const before = cloneEl(existing);
          existing.src = src;
          fillNode(pv, existing);
          pushOp({ page: pv.page, removed: [[i, before]], added: [[i, existing]] });
        }
      } else if (src) {
        const el: TexEl = { t: 'x', id: uid(), x, y, c: ts.tex.c, fs: ts.tex.fs, src };
        all.push(el);
        makeNode(pv, el);
        // Centre the formula vertically on the tapped point
        el.y = Math.max(0, y - (el.h ?? 0) / 2);
        placeNode(pv, el);
        pushOp({ page: pv.page, removed: [], added: [[all.length - 1, el]] });
      }
      closeTex();
    };
    ta.addEventListener('input', update);
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') closeTex();
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); }
    });
    texPanel = h('div', { class: 'tex-panel' },
      h('div', { class: 'tex-head' }, h('strong', null, existing ? 'Edit LaTeX' : 'Insert LaTeX'),
        h('span', { class: 'muted' }, 'Ctrl+Enter to insert'), iconBtn('close', 'Cancel', closeTex)),
      preview, err, ta,
      h('div', { class: 'snips' }, ...SNIPPETS.map(([label, s, back]) =>
        h('button', { type: 'button', class: 'snip', title: s, onpointerdown: (e: Event) => e.preventDefault(), onclick: () => insert(s, back) }, label))),
      h('div', { class: 'modal-actions' },
        h('button', { class: 'btn', type: 'button', onclick: closeTex }, 'Cancel'),
        h('button', { class: 'btn primary', type: 'button', onclick: commit }, existing ? 'Update' : 'Insert')));
    stage.append(texPanel);
    editing = { finish: commit };
    update();
    ta.focus();
  }

  // ---------- pointer input ----------
  const touches = new Map<number, { x: number; y: number }>();
  let pinch: { d: number; z: number; mx: number; my: number } | null = null;
  let touchPan = false, vx = 0, vy = 0, lastT = 0, inertia = 0;

  const pvFromEvent = (e: PointerEvent): PV | null => {
    const el = (e.target as HTMLElement).closest?.('.page') as HTMLElement | null;
    return el ? pvs[Number(el.dataset.i)] ?? null : null;
  };
  const toPage = (pv: PV, cx: number, cy: number): [number, number] => {
    const r = pv.el.getBoundingClientRect();
    return [(cx - r.left) / zoom, (cy - r.top) / zoom];
  };
  const pressureOf = (e: PointerEvent) => (ts.pressure && e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5);

  const capture = (id: number) => { try { viewport.setPointerCapture(id); } catch { /* pointer already gone */ } };

  function onDown(e: PointerEvent) {
    const target = e.target as HTMLElement;
    if (target.closest('.editing')) return; // typing in a text box
    if (e.pointerType === 'mouse' && e.button === 2) return;
    cancelAnimationFrame(inertia);

    if (e.pointerType === 'touch') {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 1) {
        if (startRulerDrag(e)) return;
        const draws = ts.fingerDraw && ts.tool !== 'hand';
        if (draws) startAction(e); else startTouchPan(e);
      } else if (touches.size === 2) {
        if (act) cancelAction();
        const [a, b] = [...touches.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, z: zoom, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
        touchPan = false;
      }
      return;
    }
    if (e.pointerType === 'pen' && !ts.penSeen) {
      // First stylus contact: from now on fingers scroll and only the pen writes (palm rejection).
      ts.penSeen = true;
      ts.fingerDraw = false;
      saveSettings();
      syncToggles();
    }
    if (e.pointerType === 'pen' && act) cancelAction(); // a resting palm may have started something
    if (act) return;
    if (startRulerDrag(e)) return;
    if ((e.pointerType === 'mouse' && e.button === 1) || ts.tool === 'hand') {
      e.preventDefault();
      act = { k: 'pan', id: e.pointerId, x: e.clientX, y: e.clientY };
      capture(e.pointerId);
      return;
    }
    startAction(e);
  }

  function startTouchPan(e: PointerEvent) {
    touchPan = true;
    vx = vy = 0;
    lastT = e.timeStamp;
  }

  function startAction(e: PointerEvent) {
    const hadEditing = !!editing;
    editing?.finish();
    const pv = pvFromEvent(e);
    if (!pv) { setSel(null); if (e.pointerType === 'touch') startTouchPan(e); return; }
    const [x, y] = toPage(pv, e.clientX, e.clientY);
    // Stylus eraser end or barrel button erases regardless of the selected tool.
    const penErase = e.pointerType === 'pen' && (e.button === 5 || (e.buttons & 32) !== 0 || (e.buttons & 2) !== 0);
    const tool: Tool = penErase ? 'eraser' : ts.tool;
    const id = e.pointerId;

    if (tool === 'text' || tool === 'tex') {
      e.preventDefault();
      if (hadEditing) return; // this tap only closed the open editor
      measure(pv);
      const r = 4 / zoom;
      const hit = [...pv.page.els].reverse().find((el) => el.t === (tool === 'text' ? 't' : 'x') && hitEl(el, x, y, r));
      if (tool === 'text') editText(pv, (hit as TextEl) ?? null, x, y);
      else editTex(pv, (hit as TexEl) ?? null, x, y);
      return;
    }

    capture(id);
    e.preventDefault();
    if (tool !== 'select') setSel(null);
    clearLive();

    if (tool === 'pen' || tool === 'hl') {
      const under = tool === 'hl' && ts.hl.mode === 'under';
      const straight = under || (tool === 'hl' && !!ts.hl.straight);
      const o = under ? ts.ul : ts[tool];
      const kind = under ? 'pen' : tool;
      const p = straight ? 0.5 : pressureOf(e);
      const a: Action = { k: 'draw', id, pv, tool: kind, c: o.c, s: o.s, baseS: o.s, pts: [x, y, p], drawn: 1, lp: p, straight, snap: null, hx: e.clientX, hy: e.clientY, timer: 0, ruler: false };
      if (ruler && ruler.pv === pv && !straight && distToRuler(x, y) < 22 / zoom) { a.ruler = true; const q = onRuler(x, y); a.pts = [q[0], q[1], p]; }
      act = a;
      aimLive(pv);
      drawStroke(lctx, kind, o.c, o.s, a.pts, 1);
      armHold(a);
    } else if (tool === 'eraser') {
      act = { k: 'erase', id, pv, orig: pv.page.els.slice(), removed: [], added: [], dirty: false, lx: x, ly: y };
      eraseAt(x, y);
    } else if (tool === 'shape') {
      act = { k: 'shape', id, pv, x1: x, y1: y, x2: x, y2: y };
    } else if (tool === 'select') {
      measure(pv);
      const bb = sel && sel.pv === pv ? unionBBox(sel.els) : null;
      const pad = 6 / zoom;
      if (bb && sel && Math.hypot(x - (bb[0] + bb[2]) / 2, y - (bb[1] - pad - 22 / zoom)) < 16 / zoom) {
        // Rotation handle: rectangles and ellipses become strokes so they can turn freely.
        for (let i = 0; i < sel.els.length; i++) {
          const el = sel.els[i];
          if (el.t === 'h' && (el.k === 'rect' || el.k === 'ellipse')) { const st = shapeToStroke(el); const j = pv.page.els.indexOf(el); if (j >= 0) pv.page.els[j] = st; sel.els[i] = st; }
        }
        const cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2;
        act = { k: 'xform', id, pv, mode: 'rotate', x0: x, y0: y, origs: sel.els.map((el) => cloneEl(el)), ox: cx, oy: cy, d0: 1, moved: false };
      } else if (bb && sel && Math.hypot(x - bb[2] - pad, y - bb[3] - pad) < 16 / zoom) {
        act = { k: 'xform', id, pv, mode: 'scale', x0: x, y0: y, origs: sel.els.map((el) => cloneEl(el)), ox: bb[0], oy: bb[1], d0: Math.hypot(bb[2] - bb[0], bb[3] - bb[1]) || 1, moved: false };
      } else if (bb && sel && x >= bb[0] - pad && x <= bb[2] + pad && y >= bb[1] - pad && y <= bb[3] + pad) {
        act = { k: 'xform', id, pv, mode: 'move', x0: x, y0: y, origs: sel.els.map((el) => cloneEl(el)), ox: 0, oy: 0, d0: 1, moved: false };
      } else {
        setSel(null);
        act = { k: 'lasso', id, pv, pts: [x, y] };
      }
    }
  }

  let frame = 0;
  const schedule = (fn: () => void) => { cancelAnimationFrame(frame); frame = requestAnimationFrame(fn); };

  function onMove(e: PointerEvent) {
    if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
      const t = touches.get(e.pointerId)!;
      const dx = e.clientX - t.x, dy = e.clientY - t.y;
      t.x = e.clientX; t.y = e.clientY;
      if (pinch && touches.size >= 2) {
        const [a, b] = [...touches.values()];
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        viewport.scrollLeft -= mx - pinch.mx;
        viewport.scrollTop -= my - pinch.my;
        pinch.mx = mx; pinch.my = my;
        setZoom(pinch.z * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.d), mx, my);
        return;
      }
      if (touchPan) {
        viewport.scrollLeft -= dx;
        viewport.scrollTop -= dy;
        const dt = Math.max(1, e.timeStamp - lastT);
        lastT = e.timeStamp;
        vx = vx * 0.6 + (dx / dt) * 0.4;
        vy = vy * 0.6 + (dy / dt) * 0.4;
        return;
      }
    }
    const a = act;
    if (!a || a.id !== e.pointerId) return;

    if (a.k === 'ruler' && ruler) {
      const [x, y] = toPage(a.pv, e.clientX, e.clientY);
      const dx = x - a.sx, dy = y - a.sy;
      if (a.part === 'body') { ruler.x1 = a.o.x1 + dx; ruler.y1 = a.o.y1 + dy; ruler.x2 = a.o.x2 + dx; ruler.y2 = a.o.y2 + dy; }
      else if (a.part === 'a') { ruler.x1 = a.o.x1 + dx; ruler.y1 = a.o.y1 + dy; }
      else { ruler.x2 = a.o.x2 + dx; ruler.y2 = a.o.y2 + dy; }
      if (e.shiftKey || a.part !== 'body') { const ang = Math.atan2(ruler.y2 - ruler.y1, ruler.x2 - ruler.x1); const snapA = Math.round(ang / (Math.PI / 36)) * (Math.PI / 36); if (Math.abs(snapA - ang) < 0.03) { const L = Math.hypot(ruler.x2 - ruler.x1, ruler.y2 - ruler.y1); if (a.part === 'a') { ruler.x1 = ruler.x2 - Math.cos(snapA) * L; ruler.y1 = ruler.y2 - Math.sin(snapA) * L; } else { ruler.x2 = ruler.x1 + Math.cos(snapA) * L; ruler.y2 = ruler.y1 + Math.sin(snapA) * L; } } }
      updateRuler();
      return;
    }
    if (a.k === 'pan') {
      viewport.scrollLeft -= e.clientX - a.x;
      viewport.scrollTop -= e.clientY - a.y;
      a.x = e.clientX; a.y = e.clientY;
      return;
    }
    const r = a.pv.el.getBoundingClientRect();

    if (a.k === 'draw' && (a.snap || a.straight)) {
      const x = (e.clientX - r.left) / zoom, y = (e.clientY - r.top) / zoom;
      if (a.straight) {
        // Straight highlighter / underline: a segment from the start point, levelled when nearly horizontal.
        let [ex, ey] = axisSnap(a.pts[0], a.pts[1], x, y, 8);
        let sx = a.pts[0], sy = a.pts[1];
        const line = ts.textSnap ? nearestLine(a.pv, sx, sy) : null;
        if (line && Math.abs(ey - sy) < line.size * 1.5) {
          // On printed text: sit on the baseline (underline) or cover the line (highlight), width from the font size.
          const under = a.tool === 'pen';
          sy = ey = under ? line.base + line.size * 0.14 : line.base - line.size * 0.32;
          a.s = under ? Math.max(0.7, line.size * 0.075) : line.size * 1.15;
          sx = Math.max(line.x1 - 1, Math.min(sx, ex)); ex = Math.min(line.x2 + 1, Math.max(a.pts[0], x));
          if (ex - sx < 2) ex = sx + 2;
        } else a.s = a.baseS;
        a.pts = [sx, sy, 0.5, ex, ey, 0.5];
      } else if (a.snap!.k === 'line') {
        // After snapping to a line, the end can still be dragged while the pen stays down.
        if (Math.hypot(e.clientX - a.hx, e.clientY - a.hy) < 6) return;
        a.hx = -1e9;
        [a.snap!.x2, a.snap!.y2] = axisSnap(a.snap!.x1, a.snap!.y1, x, y);
      } else return;
      clearLive();
      aimLive(a.pv);
      drawEls(lctx, [drawnEl(a)]);
      return;
    }
    if (a.k === 'draw') {
      // Use every sample the digitiser produced since the last frame, not just the latest one.
      const evs = e.getCoalescedEvents?.() ?? [];
      const list = evs.length ? evs : [e];
      const minD = 0.45 / zoom;
      const pts = a.pts;
      const sm = a.tool === 'pen' && !a.ruler && ev_isPen(e) ? ts.smooth * 0.8 : 0;
      for (const ev of list) {
        let x = (ev.clientX - r.left) / zoom, y = (ev.clientY - r.top) / zoom;
        const l = pts.length - 3;
        if (a.ruler) [x, y] = onRuler(x, y);
        else if (sm) { x = pts[l] * sm + x * (1 - sm); y = pts[l + 1] * sm + y * (1 - sm); }
        if (Math.abs(x - pts[l]) < minD && Math.abs(y - pts[l + 1]) < minD) continue;
        a.lp = a.lp * 0.55 + pressureOf(ev) * 0.45;
        pts.push(x, y, a.lp);
      }
      const n = pts.length / 3;
      if (a.tool === 'hl') {
        lctx.save();
        lctx.setTransform(1, 0, 0, 1, 0, 0);
        lctx.clearRect(0, 0, live.width, live.height);
        lctx.restore();
        drawStroke(lctx, 'hl', a.c, a.s, pts, n);
      } else if (n > a.drawn) {
        drawStroke(lctx, 'pen', a.c, a.s, pts, n, a.drawn);
        a.drawn = n - 1;
      }
      if (Math.hypot(e.clientX - a.hx, e.clientY - a.hy) > 5) { a.hx = e.clientX; a.hy = e.clientY; armHold(a); }
      return;
    }
    const x = (e.clientX - r.left) / zoom, y = (e.clientY - r.top) / zoom;

    if (a.k === 'erase') {
      const evs = e.getCoalescedEvents?.() ?? [];
      for (const ev of evs.length ? evs : [e]) {
        // Sweep from the previous sample so fast swipes cannot jump over thin strokes.
        const x = (ev.clientX - r.left) / zoom, y = (ev.clientY - r.top) / zoom;
        const step = Math.max(0.5, ts.eraser.s / 2 / zoom), d = Math.hypot(x - a.lx, y - a.ly), n = Math.ceil(d / step);
        for (let i = 1; i <= n; i++) eraseAt(a.lx + ((x - a.lx) * i) / n, a.ly + ((y - a.ly) * i) / n);
        a.lx = x; a.ly = y;
      }
    } else if (a.k === 'shape') {
      a.x2 = x; a.y2 = y;
      if (e.shiftKey) [a.x2, a.y2] = constrain(a.x1, a.y1, x, y, ts.shape.k);
      clearLive();
      aimLive(a.pv);
      drawShape(lctx, ts.shape.k, ts.shape.c, ts.shape.s, a.x1, a.y1, a.x2, a.y2);
    } else if (a.k === 'lasso') {
      a.pts.push(x, y);
      clearLive();
      aimLive(a.pv);
      lctx.strokeStyle = '#2742c4';
      lctx.lineWidth = 1.4 / zoom;
      lctx.setLineDash([5 / zoom, 4 / zoom]);
      lctx.beginPath();
      lctx.moveTo(a.pts[0], a.pts[1]);
      for (let i = 2; i < a.pts.length; i += 2) lctx.lineTo(a.pts[i], a.pts[i + 1]);
      lctx.stroke();
      lctx.setLineDash([]);
    } else if (a.k === 'xform' && sel) {
      const els = sel.els;
      let dx = 0, dy = 0, k = 1, rot = 0;
      if (a.mode === 'move') {
        dx = x - a.x0; dy = y - a.y0;
        if (ts.snapGrid) { const g = 10, bb = unionBBox(a.origs)!; dx = Math.round((bb[0] + dx) / g) * g - bb[0]; dy = Math.round((bb[1] + dy) / g) * g - bb[1]; }
      } else if (a.mode === 'scale') k = Math.max(0.1, Math.hypot(x - a.ox, y - a.oy) / a.d0);
      else {
        rot = Math.atan2(y - a.oy, x - a.ox) - Math.atan2(a.y0 - a.oy, a.x0 - a.ox);
        if (e.shiftKey) rot = Math.round(rot / (Math.PI / 12)) * (Math.PI / 12);
      }
      a.moved = true;
      for (let i = 0; i < els.length; i++) xformEl(a.origs[i], els[i], dx, dy, k, a.ox, a.oy, rot);
      schedule(() => {
        redrawInk(a.pv);
        for (const el of els) if (el.t === 't' || el.t === 'x') placeNode(a.pv, el);
        if (a.mode === 'scale') measure(a.pv);
        updateSelBox();
      });
    }
  }

  const ev_isPen = (e: PointerEvent) => e.pointerType !== 'touch';

  // ---------- ruler ----------
  function distToRuler(x: number, y: number): number {
    if (!ruler) return Infinity;
    const [px, py] = onRuler(x, y);
    return Math.hypot(px - x, py - y);
  }
  /** Projects a page point onto the ruler's edge. */
  function onRuler(x: number, y: number): [number, number] {
    if (!ruler) return [x, y];
    const dx = ruler.x2 - ruler.x1, dy = ruler.y2 - ruler.y1, l2 = dx * dx + dy * dy || 1;
    const t = ((x - ruler.x1) * dx + (y - ruler.y1) * dy) / l2;
    return [ruler.x1 + dx * t, ruler.y1 + dy * t];
  }
  function updateRuler() {
    if (!ruler) { rulerEl.remove(); rulerBtn.classList.remove('active'); return; }
    if (rulerEl.parentElement !== ruler.pv.el) ruler.pv.el.append(rulerEl);
    const len = Math.hypot(ruler.x2 - ruler.x1, ruler.y2 - ruler.y1);
    rulerEl.style.left = ruler.x1 * zoom + 'px';
    rulerEl.style.top = ruler.y1 * zoom + 'px';
    rulerEl.style.width = len * zoom + 'px';
    rulerEl.style.transform = `rotate(${Math.atan2(ruler.y2 - ruler.y1, ruler.x2 - ruler.x1)}rad)`;
    rulerEl.dataset.angle = Math.round(Math.atan2(ruler.y2 - ruler.y1, ruler.x2 - ruler.x1) * 180 / Math.PI * 10) / 10 + '°';
    rulerBtn.classList.add('active');
  }
  function toggleRuler() {
    if (ruler) { ruler = null; updateRuler(); return; }
    const pv = pvs[curIdx];
    const vr = viewport.getBoundingClientRect();
    const [cx, cy] = toPage(pv, vr.left + vr.width / 2, vr.top + vr.height / 2);
    const half = Math.min(pageW(pv.page, nb) * 0.35, (vr.width / zoom) * 0.35);
    ruler = { pv, x1: cx - half, y1: cy, x2: cx + half, y2: cy };
    updateRuler();
    toast('Draw along the ruler’s upper edge. Drag it to move, drag the ends to turn it.');
  }
  function startRulerDrag(e: PointerEvent): boolean {
    const t = (e.target as HTMLElement).closest?.('.ruler') as HTMLElement | null;
    if (!t || !ruler) return false;
    e.preventDefault();
    const [x, y] = toPage(ruler.pv, e.clientX, e.clientY);
    const part = (e.target as HTMLElement).classList.contains('a') ? 'a' : (e.target as HTMLElement).classList.contains('b') ? 'b' : 'body';
    act = { k: 'ruler', id: e.pointerId, pv: ruler.pv, part, sx: x, sy: y, o: { ...ruler } };
    capture(e.pointerId);
    return true;
  }

  // ---------- growing pages ----------
  let grewOnce = false;
  /** Adds half a page of space below a PDF page when something is placed near its bottom edge. */
  function maybeGrow(pv: PV, bottom: number) {
    if (!ts.grow || pv.page.bg.k !== 'pdf') return;
    const H = pageH(pv.page);
    if (bottom < H - 40) return;
    pv.page.ext = (pv.page.ext ?? 0) + Math.round(pv.page.h / 2);
    sizePV(pv);
    renderPV(pv);
    markDirty(pv.page);
    updateSelBox();
    if (!grewOnce) { grewOnce = true; toast('Page extended downward. It grows as you write; remove empty space from the margin menu.'); }
  }
  function trimPage(pv: PV) {
    const p = pv.page;
    if (!p.ext) return;
    let bottom = p.h;
    for (const e of p.els) bottom = Math.max(bottom, elBBox(e)[3] + 30);
    p.ext = Math.max(0, Math.ceil(bottom - p.h));
    sizePV(pv);
    renderPV(pv);
    markDirty(p);
    updateSelBox();
  }

  // ---------- handwriting recognition ----------
  async function convertSel(kind: 'latex' | 'text') {
    if (!sel) return;
    const { pv, els } = sel;
    const ink: El[] = els.filter((e) => e.t === 's' || e.t === 'h');
    if (!ink.length) { toast('Select some handwriting first.'); return; }
    if (!recogReady()) { toast('Add your API key first: Settings → Handwriting recognition.'); settingsPopover(); return; }
    try {
      toast(kind === 'latex' ? 'Reading the maths…' : 'Reading the handwriting…', true);
      const { png } = inkToPng(ink);
      const out = await recogInk(png, kind);
      if (!sel || sel.pv !== pv) return;
      const bb = unionBBox(ink)!;
      const lines = kind === 'latex' ? (out.match(/\\\\/g)?.length ?? 0) + 1 : out.split('\n').length;
      const fs = Math.max(9, Math.min(36, ((bb[3] - bb[1]) / lines) * (kind === 'latex' ? 0.55 : 0.7)));
      const el: El = kind === 'latex'
        ? { t: 'x', id: uid(), x: bb[0], y: bb[1], c: ts.tex.c, fs, src: out }
        : { t: 't', id: uid(), x: bb[0], y: bb[1], c: ts.text.c, fs, text: out };
      const all = pv.page.els;
      const removed = ink.map((e) => [all.indexOf(e), e] as [number, El]);
      pv.page.els = all.filter((e) => !ink.includes(e));
      pv.page.els.push(el);
      setSel(null);
      refreshPage(pv);
      pushOp({ page: pv.page, removed, added: [[pv.page.els.length - 1, el]] });
      toast(kind === 'latex' ? 'Converted to LaTeX. Tap it with the Σ tool to edit the source.' : 'Converted to text.');
    } catch (e: any) {
      console.error(e);
      toast('Recognition failed: ' + (e?.message ?? e));
    }
  }

  function constrain(x1: number, y1: number, x2: number, y2: number, k: ShapeKind): [number, number] {
    const dx = x2 - x1, dy = y2 - y1;
    if (k === 'rect' || k === 'ellipse') { const m = Math.max(Math.abs(dx), Math.abs(dy)); return [x1 + Math.sign(dx || 1) * m, y1 + Math.sign(dy || 1) * m]; }
    const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 12)) * (Math.PI / 12), l = Math.hypot(dx, dy);
    return [x1 + Math.cos(a) * l, y1 + Math.sin(a) * l];
  }

  function eraseAt(x: number, y: number) {
    const a = act;
    if (!a || a.k !== 'erase') return;
    const r = ts.eraser.s / 2 / zoom;
    const els = a.pv.page.els;
    const partial = ts.eraser.mode === 'partial';
    const drop = (el: El) => { const j = a.added.indexOf(el); if (j >= 0) a.added.splice(j, 1); else a.removed.push([a.orig.indexOf(el), el]); };
    for (let i = els.length - 1; i >= 0; i--) {
      const el = els[i];
      if (el.t !== 's' && el.t !== 'h') continue;
      if (!hitEl(el, x, y, r)) continue;
      if (partial) {
        const st = el.t === 'h' ? shapeToStroke(el) : el;
        const pieces = eraseFromStroke(st, x, y, r);
        if (!pieces) continue;
        drop(el);
        els.splice(i, 1, ...pieces);
        a.added.push(...pieces);
      } else {
        drop(el);
        els.splice(i, 1);
      }
      a.dirty = true;
    }
    schedule(() => {
      if (a.dirty) { a.dirty = false; redrawInk(a.pv); }
      clearLive();
      aimLive(a.pv);
      lctx.strokeStyle = 'rgba(0,0,0,0.45)';
      lctx.lineWidth = 1 / zoom;
      lctx.beginPath();
      lctx.arc(x, y, r, 0, Math.PI * 2);
      lctx.stroke();
    });
  }

  function onUp(e: PointerEvent) {
    if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
      touches.delete(e.pointerId);
      if (pinch) {
        if (touches.size < 2) { pinch = null; if (touches.size === 1) { touchPan = true; vx = vy = 0; lastT = e.timeStamp; } }
        return;
      }
      if (touchPan) {
        touchPan = false;
        if (e.timeStamp - lastT < 80 && Math.hypot(vx, vy) > 0.08) glide();
        return;
      }
    }
    const a = act;
    if (!a || a.id !== e.pointerId) return;
    act = null;
    cancelAnimationFrame(frame);
    if (viewport.hasPointerCapture(e.pointerId)) viewport.releasePointerCapture(e.pointerId);
    if (e.type === 'pointercancel') { abort(a); return; }

    if (a.k === 'draw') {
      clearTimeout(a.timer);
      if (!a.snap && !a.straight) {
        const r = a.pv.el.getBoundingClientRect();
        let x = (e.clientX - r.left) / zoom, y = (e.clientY - r.top) / zoom;
        if (a.ruler) [x, y] = onRuler(x, y);
        const l = a.pts.length - 3;
        if (Math.hypot(x - a.pts[l], y - a.pts[l + 1]) > 0.3 / zoom) a.pts.push(x, y, a.lp);
      }
      const st = drawnEl(a);
      const els = a.pv.page.els;
      els.push(st);
      if (a.pv.scale) {
        const c = a.pv.ink.getContext('2d')!;
        c.setTransform(a.pv.scale, 0, 0, a.pv.scale, 0, 0);
        drawEls(c, [st]);
      }
      clearLiveSoon();
      pushOp({ page: a.pv.page, removed: [], added: [[els.length - 1, st]] });
      maybeGrow(a.pv, elBBox(st)[3]);
    } else if (a.k === 'erase') {
      clearLive();
      redrawInk(a.pv);
      const all = a.pv.page.els;
      if (a.removed.length || a.added.length) pushOp({ page: a.pv.page, removed: a.removed, added: a.added.map((el) => [all.indexOf(el), el]) });
    } else if (a.k === 'ruler') {
      return;
    } else if (a.k === 'shape') {
      clearLive();
      if (Math.hypot(a.x2 - a.x1, a.y2 - a.y1) * zoom < 4) return;
      const sh: El = { t: 'h', id: uid(), k: ts.shape.k, c: ts.shape.c, s: ts.shape.s, x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2 };
      const els = a.pv.page.els;
      els.push(sh);
      redrawInk(a.pv);
      pushOp({ page: a.pv.page, removed: [], added: [[els.length - 1, sh]] });
      maybeGrow(a.pv, Math.max(a.y1, a.y2));
    } else if (a.k === 'lasso') {
      clearLive();
      const p = a.pts;
      let len = 0;
      for (let i = 2; i < p.length; i += 2) len += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
      const els = a.pv.page.els;
      let picked: El[];
      if (len * zoom < 8) {
        const hit = [...els].reverse().find((el) => !locked(el) && hitEl(el, p[0], p[1], 6 / zoom));
        picked = hit ? [hit] : [];
      } else picked = els.filter((el) => !locked(el) && elInPoly(el, p));
      setSel({ pv: a.pv, els: picked });
    } else if (a.k === 'xform') {
      if (!a.moved || !sel) return;
      redrawInk(a.pv);
      measure(a.pv);
      updateSelBox();
      const all = a.pv.page.els;
      pushOp({
        page: a.pv.page,
        removed: a.origs.map((o, i) => [all.indexOf(sel!.els[i]), o]),
        added: sel.els.map((el) => [all.indexOf(el), el]),
      });
      const bb = unionBBox(sel.els);
      if (bb) maybeGrow(a.pv, bb[3]);
    }
  }

  /** The printed text line closest to a point on a PDF page, if the point is within the line's height. */
  function nearestLine(pv: PV, x: number, y: number): TextLine | null {
    let best: TextLine | null = null, bd = Infinity;
    for (const l of pv.lines ?? []) {
      if (x < l.x1 - l.size || x > l.x2 + l.size) continue;
      const d = Math.abs(y - (l.base - l.size * 0.35));
      if (d < bd) { bd = d; best = l; }
    }
    return best && bd < best.size * 0.9 ? best : null;
  }
  const locked = (e: El) => e.t === 'i' && !!e.lock;
  function setLock(v: boolean) {
    if (!sel) return;
    const { pv, els } = sel, all = pv.page.els;
    const removed = els.map((e) => [all.indexOf(e), cloneEl(e)] as [number, El]);
    for (const e of els) if (e.t === 'i') e.lock = v;
    pushOp({ page: pv.page, removed, added: els.map((e) => [all.indexOf(e), e]) });
    setSel(v ? null : { pv, els });
    toast(v ? 'Picture locked. Unlock it from the lasso tool’s options.' : 'Picture unlocked.');
  }
  function unlockAll(pv: PV) {
    const els = pv.page.els.filter(locked), all = pv.page.els;
    if (!els.length) return;
    const removed = els.map((e) => [all.indexOf(e), cloneEl(e)] as [number, El]);
    for (const e of els) if (e.t === 'i') e.lock = false;
    pushOp({ page: pv.page, removed, added: els.map((e) => [all.indexOf(e), e]) });
    setSel({ pv, els });
  }

  /** The element a draw gesture produces: the raw stroke, or the clean shape it snapped to. */
  function drawnEl(a: Extract<Action, { k: 'draw' }>): El {
    const s = a.snap;
    if (!s) return makeStroke(a.tool, a.c, a.s, a.pts);
    if (s.k === 'poly') return polyStroke(a.c, a.s, s.v);
    if (s.k === 'line' && a.tool === 'hl') return makeStroke('hl', a.c, a.s, [s.x1, s.y1, 0.5, s.x2, s.y2, 0.5]);
    return { t: 'h', id: uid(), k: s.k, c: a.c, s: a.s, x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2 };
  }

  /** (Re)starts the hold timer: if the pen then rests in place, the stroke is replaced by a clean shape. */
  function armHold(a: Extract<Action, { k: 'draw' }>) {
    clearTimeout(a.timer);
    if (!ts.holdSnap || a.straight || a.snap) return;
    a.timer = window.setTimeout(() => {
      if (act !== a || a.snap) return;
      const s = recognize(a.pts, 22 / zoom);
      if (!s || (a.tool === 'hl' && s.k !== 'line')) return;
      a.snap = s;
      const l = a.pts.length - 3;
      const pr = a.pv.el.getBoundingClientRect();
      a.hx = pr.left + a.pts[l] * zoom;
      a.hy = pr.top + a.pts[l + 1] * zoom;
      clearLive();
      aimLive(a.pv);
      drawEls(lctx, [drawnEl(a)]);
    }, ts.holdMs);
  }

  /** Abandons the current gesture without committing it. */
  function abort(a: Action) {
    clearLive();
    if (a.k === 'draw') clearTimeout(a.timer);
    if (a.k === 'erase') { a.pv.page.els = a.orig; redrawInk(a.pv); }
    else if (a.k === 'ruler' && ruler) { Object.assign(ruler, a.o); updateRuler(); }
    else if (a.k === 'xform' && sel) {
      for (let i = 0; i < sel.els.length; i++) xformEl(a.origs[i], sel.els[i], 0, 0);
      redrawInk(a.pv);
      for (const el of sel.els) if (el.t === 't' || el.t === 'x') placeNode(a.pv, el);
      updateSelBox();
    }
  }
  function cancelAction() {
    const a = act;
    if (!a) return;
    act = null;
    cancelAnimationFrame(frame);
    if (viewport.hasPointerCapture(a.id)) viewport.releasePointerCapture(a.id);
    abort(a);
  }

  function glide() {
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(40, now - last);
      last = now;
      viewport.scrollLeft -= vx * dt;
      viewport.scrollTop -= vy * dt;
      const f = Math.pow(0.95, dt / 16.7);
      vx *= f; vy *= f;
      if (Math.hypot(vx, vy) > 0.02) inertia = requestAnimationFrame(step);
    };
    inertia = requestAnimationFrame(step);
  }

  function onWheel(e: WheelEvent) {
    if (!(e.ctrlKey || e.metaKey)) return; // plain wheel scrolls natively
    e.preventDefault();
    const d = Math.max(-25, Math.min(25, e.deltaY));
    setZoom(zoom * Math.exp(-d * 0.01), e.clientX, e.clientY);
  }

  let scrollRaf = 0;
  function onScroll() {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; updateCurrent(); });
  }

  viewport.addEventListener('pointerdown', onDown);
  viewport.addEventListener('pointermove', onMove);
  viewport.addEventListener('pointerup', onUp);
  viewport.addEventListener('pointercancel', onUp);
  viewport.addEventListener('wheel', onWheel, { passive: false });
  viewport.addEventListener('scroll', onScroll, { passive: true });
  viewport.addEventListener('contextmenu', (e) => e.preventDefault());
  // Stop iOS/Android from starting text selection or callouts on long presses
  viewport.addEventListener('touchstart', (e) => { if (!(e.target as HTMLElement).closest('.editing')) e.preventDefault(); }, { passive: false });

  // ---------- page management ----------
  async function saveStructure() {
    nb.pages = pages.map((p) => p.id);
    nb.updated = Date.now();
    await db.putNotebook(nb);
  }
  function dropHistory() { undo.length = redo.length = 0; syncUndo(); }

  async function addPage() {
    editing?.finish();
    const cur = pages[curIdx];
    const page: Page = { id: uid(), nb: nb.id, w: pageW(cur, nb), h: cur.h, bg: { k: 'paper', tpl: cur.bg.k === 'paper' ? cur.bg.tpl : nb.marginTpl, color: cur.bg.k === 'paper' ? cur.bg.color : nb.paper }, els: [] };
    pages.splice(curIdx + 1, 0, page);
    await db.putPages([page]);
    await saveStructure();
    const i = curIdx + 1;
    buildPages();
    scrollToPage(i);
  }
  async function movePage(d: number) {
    const j = curIdx + d;
    if (j < 0 || j >= pages.length) return;
    editing?.finish();
    [pages[curIdx], pages[j]] = [pages[j], pages[curIdx]];
    await saveStructure();
    buildPages();
    scrollToPage(j);
  }
  async function deletePage() {
    if (pages.length < 2) { toast('A notebook needs at least one page.'); return; }
    const page = pages[curIdx];
    if (!(await confirmDlg(`Delete page ${curIdx + 1}?`, page.els.length ? 'Everything written on this page will be removed. This can’t be undone.' : 'This can’t be undone.'))) return;
    editing?.finish();
    const i = pages.indexOf(page);
    pages.splice(i, 1);
    dirty.delete(page);
    dropHistory();
    await db.deletePage(page.id);
    await saveStructure();
    buildPages();
    scrollToPage(Math.min(i, pages.length - 1));
  }

  function marginPopover() {
    const out = h('output', null);
    const apply = () => {
      for (const pv of pvs) if (pv.page.bg.k === 'pdf') sizePV(pv);
      for (const pv of pvs) if (pv.visible) renderPV(pv);
      updateSelBox();
      out.textContent = nb.margin ? Math.round(nb.margin * 100) + '% of page width' : 'No extra space';
      thumbsList.querySelectorAll<HTMLElement>('.thumb').forEach((t, i) => { if (t.dataset.done) paintThumb(i); });
      touchNb();
    };
    const slider = h('input', { type: 'range', min: 0, max: 500, step: 5, value: Math.round(nb.margin * 100), 'aria-label': 'Writing space on the right', oninput: () => { nb.margin = Number(slider.value) / 100; apply(); } });
    const tpl = h('select', { class: 'field', onchange: () => { nb.marginTpl = tpl.value as Tpl; for (const pv of pvs) pv.bgW = -1; apply(); } },
      ...(['blank', 'lined', 'grid', 'dots'] as Tpl[]).map((t) => h('option', { value: t, selected: t === nb.marginTpl }, t[0].toUpperCase() + t.slice(1))));
    out.textContent = nb.margin ? Math.round(nb.margin * 100) + '% of page width' : 'No extra space';
    popover(marginBtn, h('div', { class: 'form pop-form' },
      h('label', null, 'Writing space beside each PDF page'),
      h('div', { class: 'row slider-row' }, slider, out),
      h('label', null, 'Paper', tpl),
      h('button', { class: 'btn small', type: 'button', onclick: () => setZoom(fitZoom(false), 0, 0, true) }, 'Fit to width'),
      h('label', null, 'Space below this page'),
      h('div', { class: 'row' },
        h('button', { class: 'btn small', type: 'button', onclick: () => { const pv = pvs[curIdx]; pv.page.ext = (pv.page.ext ?? 0) + Math.round(pv.page.h / 2); sizePV(pv); renderPV(pv); markDirty(pv.page); } }, 'Add half a page'),
        h('button', { class: 'btn small', type: 'button', onclick: () => trimPage(pvs[curIdx]) }, 'Remove empty space'))));
  }

  function settingsPopover() {
    const toggle = (label: string, hint: string, get: () => boolean, set: (v: boolean) => void) => {
      const cb = h('input', { type: 'checkbox', checked: get(), onchange: () => { set(cb.checked); saveSettings(); syncToggles(); renderOptbar(); } });
      return h('label', { class: 'check block' }, cb, h('span', null, label, h('small', null, hint)));
    };
    const out = h('output', null, (ts.holdMs / 1000).toFixed(2) + ' s');
    const delay = h('input', { type: 'range', min: 250, max: 1000, step: 50, value: ts.holdMs, 'aria-label': 'Hold time', oninput: () => { ts.holdMs = Number(delay.value); out.textContent = (ts.holdMs / 1000).toFixed(2) + ' s'; saveSettings(); } });
    popover(settingsBtn, h('div', { class: 'form pop-form' },
      toggle('Pressure sensitivity', 'Pen strokes get thicker when you press harder', () => ts.pressure, (v) => (ts.pressure = v)),
      toggle('Hold to straighten', 'Rest the pen at the end of a stroke to get a clean line, rectangle, ellipse or triangle', () => ts.holdSnap, (v) => (ts.holdSnap = v)),
      h('label', null, 'Hold time'),
      h('div', { class: 'row slider-row' }, delay, out),
      toggle('Straight highlighter', 'Highlighter always draws straight lines', () => !!ts.hl.straight, (v) => (ts.hl.straight = v)),
      toggle('Draw with finger', 'Off: fingers only scroll and zoom, the stylus writes', () => ts.fingerDraw, (v) => (ts.fingerDraw = v)),
      toggle('Snap to printed text', 'Underlines and straight highlights on PDF pages follow the text lines, with matching thickness', () => ts.textSnap, (v) => { ts.textSnap = v; if (v) for (const pv of pvs) pv.lines = null; }),
      h('label', null, 'Stroke smoothing'),
      (() => { const o = h('output', null, Math.round(ts.smooth * 100) + '%'); const s = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: ts.smooth, 'aria-label': 'Stroke smoothing', oninput: () => { ts.smooth = Number(s.value); o.textContent = Math.round(ts.smooth * 100) + '%'; saveSettings(); } }); return h('div', { class: 'row slider-row' }, s, o); })(),
      toggle('Pages grow downward', 'PDF pages get more space below when you write near the bottom edge', () => ts.grow, (v) => (ts.grow = v)),
      h('label', null, 'Appearance'),
      h('div', { class: 'seg tight' }, ...([['system', 'System'], ['light', 'Light'], ['dark', 'Dark']] as const).map(([v, label]) =>
        h('button', { type: 'button', class: themeSetting() === v ? 'active' : '', onclick: (e: Event) => { setThemeSetting(v); applyTheme(); const seg = (e.currentTarget as HTMLElement).parentElement!; seg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === e.currentTarget)); } }, label))),
      h('label', null, 'Handwriting recognition (lasso → To LaTeX / To text)'),
      (() => {
        const c = recogConfig();
        const key = h('input', { type: 'password', class: 'field', value: c.key, placeholder: 'Claude API key (sk-ant-…)', autocomplete: 'off', onchange: () => saveRecogConfig({ ...recogConfig(), key: key.value.trim() }) });
        const model = h('select', { class: 'field', onchange: () => saveRecogConfig({ ...recogConfig(), model: model.value }) }, ...RECOG_MODELS.map(([v, l]) => h('option', { value: v, selected: v === c.model }, l)));
        return h('div', { class: 'form' }, key, model, h('small', { class: 'hint' }, 'The key stays in this browser and is sent only to api.anthropic.com, together with an image of the selected strokes. Get one at console.anthropic.com.'));
      })(),
      h('label', null, 'Toolbar position'),
      h('div', { class: 'seg tight' }, ...([['top', 'Top'], ['left', 'Left side']] as const).map(([v, label]) =>
        h('button', { type: 'button', class: ts.toolbar === v ? 'active' : '', onclick: (e: Event) => { ts.toolbar = v; saveSettings(); syncToggles(); const seg = (e.currentTarget as HTMLElement).parentElement!; seg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === e.currentTarget)); } }, label)))));
  }

  // ---------- pictures & clipboard ----------
  /** Adds a picture to the current page, centred on a client position (default: middle of the view). */
  async function addImage(file: Blob, cx?: number, cy?: number) {
    try {
      editing?.finish();
      let bmp = await createImageBitmap(file);
      let blob: Blob = file;
      const MAX = 2400;
      if (Math.max(bmp.width, bmp.height) > MAX || !/^image\/(png|jpeg)$/.test(file.type)) {
        // Re-encode oversized or exotic formats (WebP, GIF, BMP...) so storage and PDF export stay simple.
        const k = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
        const c = h('canvas', { width: Math.round(bmp.width * k), height: Math.round(bmp.height * k) });
        c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
        const type = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
        blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), type, 0.9));
        bmp = await createImageBitmap(blob);
      }
      const vr = viewport.getBoundingClientRect();
      cx ??= vr.left + vr.width / 2;
      cy ??= vr.top + vr.height * 0.4;
      let pv = pvs[curIdx];
      for (const p of pvs) { if (!p.visible) continue; const r = p.el.getBoundingClientRect(); if (cy >= r.top && cy <= r.bottom) { pv = p; break; } }
      const pw = pageW(pv.page, nb), ph = pageH(pv.page);
      // 96 dpi pixels -> points, then fit within the visible width and the page.
      const k = Math.min(0.75, (Math.min(pw, vr.width / zoom) * 0.8) / bmp.width, (ph * 0.8) / bmp.height);
      const w = bmp.width * k, hh = bmp.height * k;
      const [px, py] = toPage(pv, cx, cy);
      const el: ImageEl = {
        t: 'i', id: uid(), blob: uid(), w, h: hh,
        x: Math.max(0, Math.min(pw - w, px - w / 2)), y: Math.max(0, Math.min(ph - hh, py - hh / 2)),
      };
      await db.putBlob(el.blob, blob);
      cacheImage(el.blob, bmp);
      pv.page.els.push(el);
      redrawInk(pv);
      pushOp({ page: pv.page, removed: [], added: [[pv.page.els.length - 1, el]] });
      setTool('select');
      setSel({ pv, els: [el] });
      maybeGrow(pv, el.y + el.h);
    } catch (e) {
      console.error(e);
      toast('That picture could not be added.');
    }
  }

  function pasteClipboard() {
    const pv = pvs[curIdx];
    if (!pv || !clipboard.length) return;
    editing?.finish();
    const copies = clipboard.map((e) => { const c = cloneEl(e, true); xformEl(e, c, 14, 14); return c; });
    clipboard = copies.map((e) => cloneEl(e)); // the next paste lands a step further
    const start = pv.page.els.length;
    pv.page.els.push(...copies);
    refreshPage(pv);
    pushOp({ page: pv.page, removed: [], added: copies.map((c, i) => [start + i, c]) });
    setTool('select');
    setSel({ pv, els: copies });
  }

  function onPaste(e: ClipboardEvent) {
    const t = e.target as HTMLElement;
    if (t.isContentEditable || /^(INPUT|TEXTAREA)$/.test(t.tagName) || document.querySelector('.modal-back')) return;
    const img = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
    if (img) { e.preventDefault(); addImage(img); }
    else if (clipboard.length) { e.preventDefault(); pasteClipboard(); }
  }
  function onDrop(e: DragEvent) {
    const imgs = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (!imgs.length) return;
    e.preventDefault();
    imgs.forEach((f, i) => addImage(f, e.clientX + i * 20, e.clientY + i * 20));
  }
  const offImage = onImageReady(() => { for (const pv of pvs) if (pv.visible && pv.page.els.some((e) => e.t === 'i')) redrawInk(pv); });

  // ---------- toolbar ----------
  function setTool(t: Tool) {
    editing?.finish();
    if (t !== 'select') setSel(null);
    ts.tool = t;
    saveSettings();
    renderTools();
    renderOptbar();
  }
  function renderTools() {
    toolRow.replaceChildren(...TOOLS.map(([t, ic, label, key]) => {
      const b = iconBtn(ic, `${label} (${key})`, () => setTool(t), 'tool' + (ts.tool === t ? ' active' : ''));
      b.setAttribute('aria-pressed', String(ts.tool === t));
      return b;
    }));
    viewport.dataset.tool = ts.tool;
  }
  function renderOptbar() {
    const t = ts.tool;
    const kids: (Node | null)[] = [];
    const colorTool = t === 'pen' || t === 'hl' || t === 'shape' || t === 'text' || t === 'tex' ? t : null;
    const under = t === 'hl' && ts.hl.mode === 'under';
    if (t === 'hl') {
      kids.push(h('div', { class: 'seg tight' }, ...([['mark', 'Mark'], ['under', 'Underline']] as const).map(([m, label]) =>
        h('button', { type: 'button', class: (ts.hl.mode ?? 'mark') === m ? 'active' : '', onclick: () => { ts.hl.mode = m; saveSettings(); renderOptbar(); } }, label))));
    }
    if (colorTool || t === 'select') {
      const target = under ? ts.ul : colorTool ? ts[colorTool] : null;
      const cur = target ? target.c : '';
      const pick = (c: string) => {
        if (target) { target.c = c; saveSettings(); renderOptbar(); }
        else recolorSel(c);
      };
      const palette = t === 'hl' && !under ? HL : INK;
      const custom = h('input', { type: 'color', class: 'swatch custom', title: 'Custom colour', value: /^#[0-9a-f]{6}$/i.test(cur) ? cur : '#1b1b1f', onchange: () => pick(custom.value) });
      kids.push(h('div', { class: 'opt-group' },
        ...palette.map((c) => h('button', { type: 'button', class: 'swatch' + (c === cur ? ' active' : ''), style: { background: c }, title: c, 'aria-label': 'Colour ' + c, onclick: () => pick(c) })),
        custom));
    }
    if (t === 'pen' || t === 'hl' || t === 'shape' || t === 'eraser') {
      const cfg = under ? SIZES.pen : SIZES[t], o = under ? ts.ul : ts[t];
      const slider = h('input', { type: 'range', min: cfg.min, max: cfg.max, step: cfg.step, value: o.s, 'aria-label': 'Thickness', oninput: () => { o.s = Number(slider.value); saveSettings(); dots.querySelectorAll('.active').forEach((d) => d.classList.remove('active')); } });
      const dots = h('div', { class: 'opt-group' }, ...cfg.presets.map((s, i) =>
        h('button', { type: 'button', class: 'size' + (s === o.s ? ' active' : ''), title: 'Thickness ' + s, 'aria-label': 'Thickness ' + s, onclick: () => { o.s = s; saveSettings(); renderOptbar(); } },
          h('span', { style: { width: 5 + i * 5 + 'px', height: 5 + i * 5 + 'px' } }))));
      kids.push(dots, slider);
    }
    if (t === 'shape') {
      kids.push(h('div', { class: 'opt-group' }, ...(['line', 'arrow', 'rect', 'ellipse'] as ShapeKind[]).map((k) =>
        iconBtn(k, k[0].toUpperCase() + k.slice(1), () => { ts.shape.k = k; saveSettings(); renderOptbar(); }, 'tool' + (ts.shape.k === k ? ' active' : '')))));
      kids.push(h('span', { class: 'hint' }, 'Hold Shift for squares, circles and straight angles'));
    }
    if (t === 'text' || t === 'tex') {
      const o = ts[t];
      const out = h('output', null, o.fs + ' pt');
      const slider = h('input', { type: 'range', min: 8, max: 64, step: 1, value: o.fs, 'aria-label': 'Font size', oninput: () => { o.fs = Number(slider.value); out.textContent = o.fs + ' pt'; saveSettings(); } });
      kids.push(slider, out, h('span', { class: 'hint' }, t === 'text' ? 'Tap the page to type. Wrap maths in $…$ for inline LaTeX.' : 'Tap the page to place a formula; tap a formula to edit it.'));
    }
    if (t === 'hl' && !under) {
      const cb = h('input', { type: 'checkbox', checked: !!ts.hl.straight, onchange: () => { ts.hl.straight = cb.checked; saveSettings(); } });
      kids.push(h('label', { class: 'check' }, cb, 'Straight'));
    }
    if (t === 'hl' && under) kids.push(h('span', { class: 'hint' }, 'Drag along the text to underline it'));
    if (t === 'pen' && ts.holdSnap) kids.push(h('span', { class: 'hint' }, 'Hold still at the end of a stroke for a clean line or shape'));
    if (t === 'eraser') {
      kids.unshift(h('div', { class: 'seg tight' }, ...([['stroke', 'Whole stroke'], ['partial', 'Partial']] as const).map(([m, label]) =>
        h('button', { type: 'button', class: (ts.eraser.mode ?? 'stroke') === m ? 'active' : '', onclick: () => { ts.eraser.mode = m; saveSettings(); renderOptbar(); } }, label))));
      kids.push(h('span', { class: 'hint' }, ts.eraser.mode === 'partial' ? 'Erases only what you touch' : 'Erases whole strokes and shapes'));
    }
    if (t === 'hand') kids.push(h('span', { class: 'hint' }, 'Drag to move around. Pinch or Ctrl+scroll to zoom.'));
    if (t === 'select') {
      kids.push(
        h('button', { class: 'btn small', type: 'button', disabled: !sel, onclick: duplicateSel }, icon('copy', 16), 'Duplicate'),
        h('button', { class: 'btn small', type: 'button', disabled: !sel, onclick: deleteSel }, icon('trash', 16), 'Delete'),
        sel && sel.els.some((e) => e.t === 'i') ? h('button', { class: 'btn small', type: 'button', onclick: () => setLock(true) }, icon('lock', 16), 'Lock picture') : null,
        !sel && pvs[curIdx]?.page.els.some(locked) ? h('button', { class: 'btn small', type: 'button', onclick: () => unlockAll(pvs[curIdx]) }, icon('unlock', 16), 'Unlock pictures on this page') : null,
        sel && sel.els.some((e) => e.t === 's' || e.t === 'h') ? h('button', { class: 'btn small', type: 'button', title: 'Handwritten maths → rendered LaTeX', onclick: () => convertSel('latex') }, icon('tex', 16), 'To LaTeX') : null,
        sel && sel.els.some((e) => e.t === 's' || e.t === 'h') ? h('button', { class: 'btn small', type: 'button', title: 'Handwriting → typed text', onclick: () => convertSel('text') }, icon('text', 16), 'To text') : null,
        (() => { const cb = h('input', { type: 'checkbox', checked: ts.snapGrid, onchange: () => { ts.snapGrid = cb.checked; saveSettings(); } }); return h('label', { class: 'check' }, cb, 'Snap to grid'); })(),
        h('span', { class: 'hint' }, sel ? 'Drag to move · corner resizes · top handle rotates' : 'Circle items or tap one to select'));
    }
    optbar.replaceChildren(...(ts.toolbar === 'left' ? [titleInput] : []), ...kids.filter((k): k is Node => !!k));
  }
  function syncToggles() {
    fingerBtn.classList.toggle('active', ts.fingerDraw);
    fingerBtn.title = ts.fingerDraw ? 'Finger drawing is on (two fingers scroll)' : 'Finger drawing is off (finger scrolls)';
    fingerBtn.setAttribute('aria-label', 'Draw with finger');
    fingerBtn.setAttribute('aria-pressed', String(ts.fingerDraw));
    sideBtn.classList.toggle('active', ts.sidebar);
    view.classList.toggle('with-thumbs', ts.sidebar);
    view.classList.toggle('tb-left', ts.toolbar === 'left');
    // With the toolbar on the left, the title moves into the options bar.
    if (ts.toolbar === 'left') { if (titleInput.parentElement !== optbar) { optbar.prepend(titleInput); } } else if (titleInput.parentElement !== toolbarEl) toolbarEl.insertBefore(titleInput, toolbarEl.children[1]);
    requestAnimationFrame(sizeLive);
  }

  function onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || document.querySelector('.modal-back')) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); }
    else if (mod && key === 'y') { e.preventDefault(); doRedo(); }
    else if (mod && key === 'd' && sel) { e.preventDefault(); duplicateSel(); }
    else if (mod && key === 'c' && sel) { clipboard = sel.els.map((el) => cloneEl(el)); toast('Copied. Ctrl+V pastes it on the page you are viewing.'); }
    else if (mod && (key === '0')) { e.preventDefault(); setZoom(fitZoom(false), 0, 0, true); }
    else if (mod && (key === '=' || key === '+')) { e.preventDefault(); setZoom(zoom * 1.2, 0, 0, true); }
    else if (mod && key === '-') { e.preventDefault(); setZoom(zoom / 1.2, 0, 0, true); }
    else if ((key === 'delete' || key === 'backspace') && sel) { e.preventDefault(); deleteSel(); }
    else if (key === 'escape') { setSel(null); closeTex(); }
    else if (!mod && !e.altKey) {
      const tool = TOOLS.find((x) => x[3].toLowerCase() === key);
      if (tool) setTool(tool[0]);
      else if (key === 'r') toggleRuler();
    }
  }
  const onHide = () => { if (document.visibilityState === 'hidden') flush().then(() => { if (syncEnabled()) sync(true); }); };
  const pushTimer = window.setInterval(async () => { if (syncEnabled() && navigator.onLine && (dirty.size || (await db.dirty()).length)) { await flush(); sync(true); } }, 45000);
  const ro = new ResizeObserver(() => { sizeLive(); });
  document.addEventListener('keydown', onKey);
  document.addEventListener('paste', onPaste);
  viewport.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
  viewport.addEventListener('drop', onDrop);
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', flush);
  ro.observe(stage);

  // ---------- start ----------
  renderTools();
  renderOptbar();
  syncToggles();
  syncUndo();
  sizeLive();
  zoom = fitZoom(true);
  pagesEl.style.setProperty('--z', String(zoom));
  zoomBtn.textContent = Math.round(zoom * 100) + '%';
  buildPages();
  document.fonts?.ready.then(() => { for (const pv of pvs) if (pv.built) measure(pv); });

  return {
    async close() {
      if (closed) return;
      closed = true;
      editing?.finish();
      cancelAction();
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('paste', onPaste);
      offImage();
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', flush);
      clearInterval(pushTimer);
      ro.disconnect();
      io.disconnect();
      thumbIo.disconnect();
      for (const pv of pvs) pv.job?.cancel();
      try { nb.cover = await makeCover(pages[0], nb); } catch { /* keep the old cover */ }
      await flush();
      closeDocs();
      clearTextLines();
    },
  };
}
