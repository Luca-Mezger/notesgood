// Small DOM helpers: element builder, icons, modal, menu, popover, toast.

type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K, props?: Record<string, any> | null, ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k in el && k !== 'list') (el as any)[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

const ICONS: Record<string, string> = {
  back: 'M15 5l-7 7 7 7',
  undo: 'M9 6L4 11l5 5M4 11h10a5 5 0 0 1 0 10h-3',
  redo: 'M15 6l5 5-5 5M20 11H10a5 5 0 0 0 0 10h3',
  pen: 'M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19l-4 1zM14.5 6.5l3 3',
  hl: 'M7 14l8-10 5 5-10 8zM7 14l-2 4 2 2 3-3M3 21h18',
  eraser: 'M4 15l9-9a2 2 0 0 1 3 0l4 4a2 2 0 0 1 0 3l-7 7H8l-4-4a1 1 0 0 1 0-1zM9 10l6 6M8 20h12',
  shape: 'M3 13h9v8H3zM16.5 3a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9z',
  text: 'M5 6V4h14v2M12 4v16M9 20h6',
  tex: 'M17 6V4H6l6 8-6 8h11v-2',
  lasso: 'M12 4c5 0 9 2.5 9 6s-4 6-9 6-9-2.5-9-6 4-6 9-6zM8 15.5c0 2-1 3.5-3 4.5',
  hand: 'M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3',
  pages: 'M4 4h16v16H4zM9 4v16',
  plus: 'M12 5v14M5 12h14',
  trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13M10 11v6M14 11v6',
  up: 'M6 15l6-6 6 6',
  down: 'M6 9l6 6 6-6',
  finger: 'M9 11V5a1.5 1.5 0 0 1 3 0v5l5 1.2a2 2 0 0 1 1.5 2.3L17.5 20h-7L6 14.5a1.5 1.5 0 0 1 2.3-1.9L9 13.5',
  margin: 'M4 4h16v16H4zM14 4v16M16.5 9H18M16.5 12H18M16.5 15H18',
  more: 'M5 12a1 1 0 1 0 2 0 1 1 0 1 0-2 0M11 12a1 1 0 1 0 2 0 1 1 0 1 0-2 0M17 12a1 1 0 1 0 2 0 1 1 0 1 0-2 0',
  star: 'M12 4l2.5 5.2 5.5.8-4 4 1 5.6-5-2.7-5 2.7 1-5.6-4-4 5.5-.8z',
  copy: 'M8 8h11v11H8zM5 16V5h11',
  import: 'M12 16V4M7 9l5-5 5 5M4 20h16',
  search: 'M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zM16 16l4.5 4.5',
  folder: 'M3 6h6l2 2h10v11H3z',
  line: 'M5 19L19 5',
  arrow: 'M5 19L19 5M11 5h8v8',
  rect: 'M4 6h16v12H4z',
  ellipse: 'M12 6c4.4 0 8 2.7 8 6s-3.6 6-8 6-8-2.7-8-6 3.6-6 8-6z',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  close: 'M6 6l12 12M18 6L6 18',
  export: 'M12 4v12M7 11l5 5 5-5M4 20h16',
  sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 4.5v5M9 14.5v5',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6zM12 14.5v2.5',
  unlock: 'M7 11V8a5 5 0 0 1 9.6-2M6 11h12v9H6zM12 14.5v2.5',
  ruler: 'M3 17l14-14 4 4L7 21zM8 12l2 2M11 9l2 2M14 6l2 2',
  cloud: 'M7 18a4 4 0 0 1-.6-7.95A5.5 5.5 0 0 1 17 8.5a4.5 4.5 0 0 1 .5 9.5z',
  image: 'M4 5h16v14H4zM4 16l4.5-4.5 3.5 3.5 3-3 5 5M9 9.5a1 1 0 1 0 .01 0',
  pdf: 'M6 3h8l4 4v14H6zM14 3v4h4M9 13h6M9 17h6',
};

export function icon(name: string, size = 20): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', ICONS[name] ?? '');
  svg.append(p);
  return svg;
}

export function iconBtn(name: string, title: string, onClick: (e: MouseEvent) => void, cls = ''): HTMLButtonElement {
  return h('button', { class: 'ibtn ' + cls, title, 'aria-label': title, type: 'button', onclick: onClick }, icon(name));
}

export interface ModalOpts {
  title: string;
  body?: Node | string;
  ok?: string;
  cancel?: string | null;
  danger?: boolean;
  /** Return false to keep the dialog open. */
  onOk?: () => boolean | void | Promise<boolean | void>;
}

export function modal(o: ModalOpts): Promise<boolean> {
  return new Promise((resolve) => {
    const close = (v: boolean) => { back.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
    const ok = async () => {
      okBtn.disabled = true;
      try { if ((await o.onOk?.()) === false) { okBtn.disabled = false; return; } } catch (e) { okBtn.disabled = false; toast(String(e)); return; }
      close(true);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(false); }
      else if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement)) { e.preventDefault(); e.stopPropagation(); ok(); }
    };
    const okBtn = h('button', { class: 'btn ' + (o.danger ? 'danger' : 'primary'), type: 'button', onclick: ok }, o.ok ?? 'OK');
    const back = h('div', { class: 'modal-back', onpointerdown: (e: Event) => { if (e.target === back) close(false); } },
      h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
        h('h2', null, o.title),
        typeof o.body === 'string' ? h('p', null, o.body) : o.body,
        h('div', { class: 'modal-actions' },
          o.cancel !== null && h('button', { class: 'btn', type: 'button', onclick: () => close(false) }, o.cancel ?? 'Cancel'),
          okBtn)));
    document.body.append(back);
    document.addEventListener('keydown', onKey, true);
    const first = back.querySelector<HTMLElement>('input, textarea, select');
    (first ?? okBtn).focus();
    if (first instanceof HTMLInputElement && first.type === 'text') first.select();
  });
}

export async function promptText(title: string, value = '', okLabel = 'Save'): Promise<string | null> {
  const input = h('input', { type: 'text', class: 'field', value });
  const ok = await modal({ title, body: input, ok: okLabel });
  const v = input.value.trim();
  return ok && v ? v : null;
}

export function confirmDlg(title: string, msg: string, okLabel = 'Delete'): Promise<boolean> {
  return modal({ title, body: msg, ok: okLabel, danger: true });
}

/** Floating panel anchored to an element. Returns a function that closes it. */
export function popover(anchor: HTMLElement, content: HTMLElement): () => void {
  const pop = h('div', { class: 'popover' }, content);
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let x = Math.min(Math.max(8, r.right - pw), innerWidth - pw - 8);
  if (r.left + pw < innerWidth - 8) x = Math.max(8, r.left);
  let y = r.bottom + 6;
  if (y + ph > innerHeight - 8) y = Math.max(8, r.top - ph - 6);
  pop.style.left = x + 'px';
  pop.style.top = y + 'px';
  const close = () => { pop.remove(); document.removeEventListener('pointerdown', onDown, true); document.removeEventListener('keydown', onKey, true); };
  const onDown = (e: Event) => { if (!pop.contains(e.target as Node)) close(); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  setTimeout(() => { document.addEventListener('pointerdown', onDown, true); document.addEventListener('keydown', onKey, true); });
  return close;
}

export interface MenuItem { label: string; icon?: string; danger?: boolean; action: () => void }

export function menu(anchor: HTMLElement, items: MenuItem[]) {
  let close = () => {};
  const list = h('div', { class: 'menu' }, ...items.map((it) =>
    h('button', { type: 'button', class: it.danger ? 'danger' : '', onclick: () => { close(); it.action(); } },
      it.icon ? icon(it.icon, 18) : null, it.label)));
  close = popover(anchor, list);
}

/** Hands a generated file to the browser's download flow. */
export function download(blob: Blob, name: string) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

let toastTimer = 0;
export function toast(msg: string, sticky = false) {
  document.querySelector('.toast')?.remove();
  const t = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(t);
  clearTimeout(toastTimer);
  if (!sticky) toastTimer = window.setTimeout(() => t.remove(), 3200);
}

export function fmtDate(ts: number): string {
  const d = new Date(ts), now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? 'Today, ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}
