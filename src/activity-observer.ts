/** Passive observer only: no editor hooks, pointer capture, default prevention, or event rewriting. */
import { db } from './db';
import { idleSeconds, trackingEnabled } from './activity-store';
import { uid } from './types';
import type { ActiveKind, ActivityContext, Counter } from './activity';

type Sample = { type: string; at: number; [key: string]: unknown };
type Contact = { kind: ActiveKind; page: number; last: number; moved: boolean; pen: boolean };
export async function observeStudy(root: HTMLElement, notebookId: string) {
  if (!trackingEnabled() || typeof Worker === 'undefined') return null;
  const notebook = await db.notebook(notebookId), editor = root.querySelector<HTMLElement>('.editor');
  const viewport = editor?.querySelector<HTMLElement>('.viewport');
  if (!notebook || !editor || !viewport) return null;
  const worker = new Worker(new URL('activity-worker.js', location.href.split('#')[0]), { type: 'module' });
  const wall = Date.now(), mono = performance.now(), time = () => wall + performance.now() - mono;
  let samples: Sample[] = [], stopped = false, failed = false, sendTimer = 0, current = -1, wheelAt = -Infinity;
  let pages = notebook.pages;
  let title = notebook.title, folder = notebook.folder, refreshing = false, refreshed = 0;
  const contacts = new Map<number, Contact>();
  const abort = new AbortController(), passive = { capture: true, passive: true, signal: abort.signal };
  function enqueue(type: string, data: Record<string, unknown> = {}) {
    if (failed || stopped) return;
    samples.push({ type, at: time(), ...data });
    if (!sendTimer) sendTimer = window.setTimeout(send, 200);
  }
  function send() {
    clearTimeout(sendTimer); sendTimer = 0;
    if (!samples.length || failed) return;
    const events = samples; samples = [];
    try { worker.postMessage({ type: 'events', events }); } catch { disable(); }
  }
  function disable() { failed = true; abort.abort(); clearInterval(pageTimer); clearTimeout(sendTimer); samples = []; worker.terminate(); }
  // A telemetry failure must never escape into the editor's input dispatch.
  function listen(target: EventTarget, type: string, action: (e: any) => void) {
    target.addEventListener(type, (e) => { if (!stopped && !failed) { try { action(e); } catch { disable(); } } }, passive);
  }
  function context(index: number) {
    if (index < 0 || index >= pages.length || index === current) return;
    current = index;
    const c: ActivityContext = { notebook: notebookId, title, folder, page: pages[index], pageNumber: index + 1 };
    enqueue('context', { context: c });
  }
  function count(key: Counter, amount = 1) { enqueue('count', { key, amount }); }
  function activity(kind: ActiveKind, lease = 500) { enqueue('activity', { kind, lease }); }
  function pageAt(e: PointerEvent) {
    const target = e.target instanceof Element ? e.target : null;
    const page = target?.closest<HTMLElement>('.page');
    return page ? Number(page.dataset.i) : current;
  }
  function toolKind(e: PointerEvent): ActiveKind {
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest('.selbox, .obj, .editing, .texpanel')) return 'editing';
    const tool = viewport!.dataset.tool;
    if (e.pointerType === 'mouse') return tool === 'hand' || !target?.closest('.selbox, .objs') ? 'navigation' : 'editing';
    if (e.pointerType === 'pen' && (e.buttons & 34)) return 'erasing';
    if (e.pointerType === 'touch') {
      let finger = false;
      try { const settings = JSON.parse(localStorage.getItem('margin.tools') || '{}'); finger = settings.fingerDraw !== false && !settings.penSeen; } catch { /* default to navigation */ }
      if (!finger || contacts.size) return 'navigation';
    }
    return tool === 'pen' ? 'writing' : tool === 'hl' ? 'highlighting' : tool === 'eraser' ? 'erasing' : tool === 'hand' ? 'navigation' : 'editing';
  }
  function down(e: PointerEvent) {
    if (!viewport!.contains(e.target as Node)) { activity('editing', 250); return; }
    if (e.pointerType === 'pen' && !(e.buttons & 1) && !((e.buttons & 32) && e.pressure > 0)) return;
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return;
    if (e.pointerType === 'touch' && [...contacts.values()].some(c => c.pen)) return; // resting palm
    if (contacts.has(e.pointerId)) return;
    const kind = toolKind(e), page = pageAt(e);
    if (e.pointerType === 'touch' && contacts.size) {
      for (const c of contacts.values()) c.kind = 'navigation';
      count('zooms');
    }
    contacts.set(e.pointerId, { kind, page, last: performance.now(), moved: false, pen: e.pointerType === 'pen' });
    context(page); activity(kind, kind === 'navigation' ? 400 : 2000);
    if (kind === 'navigation') count('scrolls');
  }
  function move(e: PointerEvent) {
    let c = contacts.get(e.pointerId);
    // Some pen drivers report tip contact/release as a move after a barrel-button event.
    if (!c && e.pointerType === 'pen' && ((e.buttons & 1) || ((e.buttons & 32) && e.pressure > 0)) && viewport!.contains(e.target as Node)) { down(e); c = contacts.get(e.pointerId); }
    if (!c) return; // hover costs no DOM reads, storage writes, or messages
    if (e.pointerType === 'pen' && !(e.buttons & 1) && !(e.buttons & 32)) { up(e); return; }
    c.moved = true;
    const stamp = performance.now();
    if (stamp - c.last < 120) return;
    c.last = stamp; activity(c.kind, c.kind === 'navigation' ? 400 : 2000);
  }
  function up(e: PointerEvent) {
    const c = contacts.get(e.pointerId); if (!c) return;
    contacts.delete(e.pointerId);
    context(c.page);
    if (e.type !== 'pointercancel') {
      if (c.kind === 'writing') count('strokes');
      if (c.kind === 'highlighting') count('highlights');
      if (c.kind === 'erasing') count('erasures');
      if (c.kind === 'editing' && c.moved) count(viewport!.querySelector('.selbox') ? 'transforms' : 'selections');
    }
    if (!contacts.size) enqueue('release');
  }
  listen(editor, 'pointerdown', down); listen(window, 'pointermove', move);
  listen(window, 'pointerup', up); listen(window, 'pointercancel', up);
  listen(viewport, 'wheel', (e: WheelEvent) => {
    if (!e.deltaX && !e.deltaY) return;
    activity('navigation', 400);
    const stamp = performance.now();
    if (stamp - wheelAt > 600) count(e.ctrlKey || e.metaKey ? 'zooms' : 'scrolls');
    wheelAt = stamp;
  });
  listen(document, 'input', (e: InputEvent) => {
    if (!(e.target instanceof HTMLElement) || !e.target.matches('.editing, .tex-src')) return;
    activity('editing', 350); if (e.data) count('characters', [...e.data].length);
  });
  listen(document, 'keydown', (e: KeyboardEvent) => {
    if (e.isComposing || ['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
    activity(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key) ? 'navigation' : 'editing', 250);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') count(e.shiftKey ? 'redos' : 'undos');
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') count('redos');
  });
  listen(editor, 'click', (e: MouseEvent) => {
    const label = (e.target as Element).closest('button')?.getAttribute('aria-label');
    if (label?.startsWith('Undo')) count('undos'); else if (label?.startsWith('Redo')) count('redos');
  });
  function foreground() {
    contacts.clear(); enqueue('release');
    enqueue('foreground', { value: document.visibilityState !== 'hidden' && document.hasFocus() }); send();
    worker.postMessage({ type: 'flush' });
  }
  listen(document, 'visibilitychange', foreground); listen(window, 'focus', foreground); listen(window, 'blur', foreground);
  listen(window, 'pagehide', () => { contacts.clear(); enqueue('release'); enqueue('foreground', { value: false }); send(); worker.postMessage({ type: 'flush' }); });
  listen(window, 'pageshow', foreground);
  // Use existing thumbnail state; no layout reads in any pen-move handler.
  function readPage() {
    if (!refreshing && !contacts.size && performance.now() - refreshed > 2000) {
      refreshing = true;
      void db.notebook(notebookId).then(latest => {
        if (latest && !stopped && !failed) {
          pages = latest.pages; title = latest.title; folder = latest.folder;
          current = -1;
          const index = Number(editor!.querySelector<HTMLElement>('.thumb.current')?.dataset.i ?? 0);
          context(index);
        }
      }).catch(() => {}).finally(() => { refreshing = false; refreshed = performance.now(); });
    }
    const selected = editor!.querySelector<HTMLElement>('.thumb.current');
    if (selected) context(Number(selected.dataset.i));
  }
  const pageTimer = window.setInterval(() => { try { readPage(); } catch { disable(); } }, 750);
  const first = Number(editor.querySelector<HTMLElement>('.thumb.current')?.dataset.i ?? 0);
  current = first;
  worker.postMessage({ type: 'start', session: uid(), at: time(), idleMs: idleSeconds() * 1000, foreground: document.visibilityState !== 'hidden' && document.hasFocus(), context: { notebook: notebook.id, title, folder, page: pages[first], pageNumber: first + 1 } });
  let closeResolve: (() => void) | undefined;
  worker.onmessage = ({ data }) => {
    if (data.type === 'closed') closeResolve?.();
    else if (data.type === 'storage-error') console.warn('Analytics storage unavailable; note storage is independent.');
  };
  worker.onerror = (e) => { e.preventDefault(); disable(); console.warn('Analytics stopped; editor input is unaffected.'); };
  return {
    async close() {
      if (stopped) return;
      abort.abort(); clearInterval(pageTimer); send(); stopped = true;
      if (!failed) await new Promise<void>(resolve => {
        const timeout = window.setTimeout(resolve, 1500);
        closeResolve = () => { clearTimeout(timeout); resolve(); };
        worker.postMessage({ type: 'close', at: time() });
      });
      worker.terminate();
    },
  };
}
