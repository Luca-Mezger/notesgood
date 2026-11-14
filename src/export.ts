// Export a notebook as a PDF (vector ink on top of the original PDF pages) and
// backup/restore of notebooks as a single `.margin` file.
import { db } from './db';
import { richHtml, texHtml } from './latex';
import { renderPdfPage } from './pdf';
import { HL_ALPHA, penW, shapePoly } from './render';
import { pageH, pageW, uid, type El, type Notebook, type Page, type Stroke, type Tpl } from './types';

type Lib = typeof import('pdf-lib');
type PDFPage = import('pdf-lib').PDFPage;

const f = (n: number) => (Math.round(n * 100) / 100).toString();

function hexRgb(L: Lib, hex: string) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  const v = m ? parseInt(m[1], 16) : 0;
  return L.rgb(((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255);
}

/** Pen stroke as SVG paths, batched by similar width (mirrors render.drawStroke). */
function penPaths(st: Stroke): { w: number; d: string }[] {
  const p = st.p, n = p.length / 3, out: { w: number; d: string }[] = [];
  let sx = p[0], sy = p[1];
  let bw = penW(st.s, p[5]);
  let d = `M${f(sx)} ${f(sy)}`;
  for (let i = 1; i < n - 1; i++) {
    const a = i * 3, b = a + 3;
    const w = penW(st.s, p[a + 2]);
    if (Math.abs(w - bw) > bw * 0.07) { out.push({ w: bw, d }); d = `M${f(sx)} ${f(sy)}`; bw = w; }
    sx = (p[a] + p[b]) / 2; sy = (p[a + 1] + p[b + 1]) / 2;
    d += ` Q${f(p[a])} ${f(p[a + 1])} ${f(sx)} ${f(sy)}`;
  }
  const l = (n - 1) * 3;
  out.push({ w: bw, d: d + ` L${f(p[l])} ${f(p[l + 1])}` });
  return out;
}

function hlPath(st: Stroke): string {
  const p = st.p, n = p.length / 3;
  let d = `M${f(p[0])} ${f(p[1])}`;
  for (let i = 1; i < n - 1; i++) {
    const a = i * 3, b = a + 3;
    d += ` Q${f(p[a])} ${f(p[a + 1])} ${f((p[a] + p[b]) / 2)} ${f((p[a + 1] + p[b + 1]) / 2)}`;
  }
  const l = (n - 1) * 3;
  return d + ` L${f(p[l])} ${f(p[l + 1])}`;
}

function rulingPath(x0: number, w: number, h: number, tpl: Tpl): { d: string; width: number; opacity: number } | null {
  let d = '';
  if (tpl === 'lined') {
    for (let y = 56; y < h - 16; y += 24) d += `M${f(x0)} ${y} L${f(x0 + w)} ${y} `;
    return { d, width: 0.6, opacity: 0.22 };
  }
  if (tpl === 'grid') {
    for (let x = x0 + 20; x < x0 + w; x += 20) d += `M${f(x)} 0 L${f(x)} ${f(h)} `;
    for (let y = 20; y < h; y += 20) d += `M${f(x0)} ${y} L${f(x0 + w)} ${y} `;
    return { d, width: 0.45, opacity: 0.22 };
  }
  if (tpl === 'dots') {
    for (let x = x0 + 20; x < x0 + w; x += 20) for (let y = 20; y < h; y += 20) d += `M${f(x)} ${y} L${f(x)} ${y} `;
    return { d, width: 1.3, opacity: 0.4 };
  }
  return null;
}

// ---------- text & LaTeX rasterisation ----------
// Text boxes and formulas are HTML. For export they are drawn through an SVG <foreignObject>
// with the KaTeX fonts inlined, giving one transparent PNG overlay per page.

let cssCache: Promise<string> | null = null;
function inlineKatexCss(): Promise<string> {
  return (cssCache ??= (async () => {
    let css = await (await fetch(new URL('katex/katex.min.css', document.baseURI))).text();
    const names = [...new Set([...css.matchAll(/url\(fonts\/([\w-]+\.woff2)\)/g)].map((m) => m[1]))];
    await Promise.all(names.map(async (name) => {
      const buf = new Uint8Array(await (await fetch(new URL('katex/fonts/' + name, document.baseURI))).arrayBuffer());
      css = css.split(`url(fonts/${name})`).join(`url(data:font/woff2;base64,${b64(buf)})`);
    }));
    return css;
  })());
}

const OBJ_CSS = `
.obj{position:absolute;width:max-content;line-height:1.35;white-space:pre-wrap;overflow-wrap:anywhere;
font-family:system-ui,-apple-system,'Segoe UI',Roboto,'Noto Sans',sans-serif}
.obj.tex{white-space:nowrap;line-height:1.2}
.obj.tex .katex-display{margin:0;text-align:left}
.obj.tex .katex-display>.katex{text-align:left}`;

async function rasterObjs(page: Page, w: number, scale: number): Promise<Uint8Array | null> {
  const els = page.els.filter((e) => e.t === 't' || e.t === 'x');
  if (!els.length) return null;
  const H = pageH(page);
  const box = document.createElement('div');
  box.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
  box.style.cssText = `position:relative;width:${w}px;height:${H}px;overflow:hidden;margin:0`;
  const style = document.createElement('style');
  style.textContent = (await inlineKatexCss()) + OBJ_CSS;
  box.append(style);
  for (const e of els) {
    if (e.t !== 't' && e.t !== 'x') continue;
    const n = document.createElement('div');
    n.className = 'obj ' + (e.t === 't' ? 'txt' : 'tex');
    n.style.cssText = `left:${e.x}px;top:${e.y}px;font-size:${e.fs}px;color:${e.c};` + (e.t === 't' ? `max-width:${Math.max(60, w - e.x - 6)}px` : '');
    n.innerHTML = e.t === 't' ? richHtml(e.text) : texHtml(e.src, true);
    box.append(n);
  }
  const W = Math.round(w * scale), HP = Math.round(H * scale);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${HP}" viewBox="0 0 ${w} ${H}">` +
    `<foreignObject x="0" y="0" width="${w}" height="${H}">${new XMLSerializer().serializeToString(box)}</foreignObject></svg>`;
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = HP;
  canvas.getContext('2d')!.drawImage(img, 0, 0, W, HP);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

/** Fallback when the browser refuses to rasterise HTML: plain text, formulas as their source. */
async function drawObjsPlain(L: Lib, doc: import('pdf-lib').PDFDocument, out: PDFPage, page: Page) {
  const font = await doc.embedFont(L.StandardFonts.Helvetica);
  for (const e of page.els) {
    if (e.t !== 't' && e.t !== 'x') continue;
    const text = (e.t === 't' ? e.text : e.src).replace(/[^\x20-\x7e\n]/g, '?');
    text.split('\n').forEach((line, i) =>
      out.drawText(line, { x: e.x, y: pageH(page) - e.y - e.fs * (1 + i * 1.35), size: e.fs, font, color: hexRgb(L, e.c) }));
  }
}

// ---------- PDF export ----------

export async function exportPdf(nb: Notebook, pages: Page[], onProgress?: (done: number, total: number) => void): Promise<Blob> {
  const L = await import('pdf-lib');
  const doc = await L.PDFDocument.create();
  doc.setTitle(nb.title);
  doc.setCreator('Notesgood');
  const sources = new Map<string, Promise<import('pdf-lib').PDFDocument | null>>();
  const source = (id: string) => {
    let s = sources.get(id);
    if (!s) {
      s = db.blob(id).then(async (b) => (b ? L.PDFDocument.load(await b.arrayBuffer()) : null)).catch(() => null);
      sources.set(id, s);
    }
    return s;
  };
  const round = { borderLineCap: L.LineCapStyle.Round };
  const rule = L.rgb(60 / 255, 90 / 255, 140 / 255);
  let htmlOk = true;

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const w = pageW(page, nb), h = pageH(page);
    const out = doc.addPage([w, h]);
    out.pushOperators(L.setLineJoin(L.LineJoinStyle.Round));
    const path = (d: string, o: Record<string, unknown>) => out.drawSvgPath(d, { x: 0, y: h, ...o });

    // Background
    if (page.bg.k === 'paper') {
      out.drawRectangle({ x: 0, y: 0, width: w, height: h, color: hexRgb(L, page.bg.color) });
      const r = rulingPath(0, w, h, page.bg.tpl);
      if (r) path(r.d, { borderColor: rule, borderWidth: r.width, borderOpacity: r.opacity, ...round });
    } else {
      if (h > page.h) {
        const r = rulingPath(0, w, h, nb.marginTpl);
        if (r) path(r.d, { borderColor: rule, borderWidth: r.width, borderOpacity: r.opacity, ...round });
        out.drawRectangle({ x: 0, y: h - page.h, width: page.w, height: page.h, color: L.rgb(1, 1, 1) });
      }
      let embedded = false;
      try {
        const src = await source(page.bg.blob);
        const sp = src?.getPage(page.bg.n - 1);
        if (src && sp) {
          const cb = sp.getCropBox();
          const emb = await doc.embedPage(sp, { left: cb.x, bottom: cb.y, right: cb.x + cb.width, top: cb.y + cb.height });
          const rot = ((sp.getRotation().angle % 360) + 360) % 360;
          // The viewer rotates pages clockwise by /Rotate; embedded pages ignore it, so apply it here.
          const top = h, bot = h - page.h;
          const pos = rot === 90 ? { x: 0, y: top } : rot === 180 ? { x: page.w, y: top } : rot === 270 ? { x: page.w, y: bot } : { x: 0, y: bot };
          out.drawPage(emb, { ...pos, width: emb.width, height: emb.height, rotate: L.degrees(-rot) });
          embedded = true;
        }
      } catch (e) { console.warn('Embedding PDF page failed, using an image instead', e); }
      if (!embedded) {
        // Encrypted or unusual PDFs: fall back to a rendered image of the page.
        const canvas = await renderPdfPage(page.bg.blob, page.bg.n, 2.5).promise;
        if (canvas) {
          const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
          if (blob) out.drawImage(await doc.embedJpg(await blob.arrayBuffer()), { x: 0, y: h - page.h, width: page.w, height: page.h });
        }
      }
      if (w > page.w) {
        const r = rulingPath(page.w, w - page.w, h, nb.marginTpl);
        if (r) path(r.d, { borderColor: rule, borderWidth: r.width, borderOpacity: r.opacity, ...round });
        out.drawLine({ start: { x: page.w, y: 0 }, end: { x: page.w, y: h }, thickness: 0.6, color: L.rgb(0, 0, 0), opacity: 0.13 });
      }
      if (h > page.h) {
        out.drawLine({ start: { x: 0, y: h - page.h }, end: { x: page.w, y: h - page.h }, thickness: 0.6, color: L.rgb(0, 0, 0), opacity: 0.13 });
      }
    }

    // Pictures (always beneath the ink)
    for (const e of page.els) {
      if (e.t !== 'i') continue;
      try {
        const blob = await db.blob(e.blob);
        if (!blob) continue;
        const buf = await blob.arrayBuffer();
        const img = blob.type === 'image/png' ? await doc.embedPng(buf) : await doc.embedJpg(buf);
        out.drawImage(img, { x: e.x, y: h - e.y - e.h, width: e.w, height: e.h });
      } catch (err) { console.warn('Could not embed picture', err); }
    }

    // Ink
    for (const e of page.els) {
      if (e.t === 's') {
        const color = hexRgb(L, e.c);
        if (e.k === 'hl') path(hlPath(e), { borderColor: color, borderWidth: e.s, borderOpacity: HL_ALPHA, ...round });
        else if (e.p.length === 3) out.drawCircle({ x: e.p[0], y: h - e.p[1], size: penW(e.s, e.p[2]) / 2, color });
        else for (const b of penPaths(e)) path(b.d, { borderColor: color, borderWidth: b.w, ...round });
      } else if (e.t === 'h') {
        const color = hexRgb(L, e.c);
        const poly = shapePoly(e);
        let d = `M${f(poly[0])} ${f(poly[1])}`;
        for (let k = 2; k < poly.length; k += 2) d += ` L${f(poly[k])} ${f(poly[k + 1])}`;
        if (e.k === 'rect' || e.k === 'ellipse') d += ' Z';
        if (e.k === 'arrow') {
          const a = Math.atan2(e.y2 - e.y1, e.x2 - e.x1), len = Math.max(8, e.s * 4.5);
          d += ` M${f(e.x2 - len * Math.cos(a - 0.45))} ${f(e.y2 - len * Math.sin(a - 0.45))} L${f(e.x2)} ${f(e.y2)} L${f(e.x2 - len * Math.cos(a + 0.45))} ${f(e.y2 - len * Math.sin(a + 0.45))}`;
        }
        path(d, { borderColor: color, borderWidth: e.s, ...round });
      }
    }

    // Text and formulas
    if (page.els.some((e) => e.t === 't' || e.t === 'x')) {
      let png: Uint8Array | null = null;
      if (htmlOk) { try { png = await rasterObjs(page, w, 3); } catch (e) { console.warn(e); htmlOk = false; } }
      if (png) out.drawImage(await doc.embedPng(png), { x: 0, y: 0, width: w, height: h });
      else await drawObjsPlain(L, doc, out, page);
    }
    onProgress?.(i + 1, pages.length);
    if (i % 5 === 4) await new Promise((r) => setTimeout(r)); // keep the UI responsive
  }
  const bytes = await doc.save();
  return new Blob([bytes as BlobPart], { type: 'application/pdf' });
}

// ---------- backup ----------
// File layout: "MRGN" | uint32 header length (LE) | header JSON | PDF blobs back to back.

const MAGIC = 'MRGN';

function b64(u8: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  const bin = atob(s), u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

interface Header { v: 1; notebooks: Notebook[]; pages: any[]; blobs: { id: string; size: number; type?: string }[] }

export async function exportBackup(notebooks: Notebook[]): Promise<Blob> {
  const header: Header = { v: 1, notebooks, pages: [], blobs: [] };
  const parts: BlobPart[] = [];
  const seen = new Set<string>();
  for (const nb of notebooks) {
    for (const p of await db.pages(nb.id)) {
      header.pages.push({ ...p, els: p.els.map((e) => (e.t === 's' ? { ...e, p: b64(new Uint8Array(e.p.buffer, e.p.byteOffset, e.p.byteLength)) } : e)) });
      const ids = p.els.flatMap((e) => (e.t === 'i' ? [e.blob] : []));
      if (p.bg.k === 'pdf') ids.push(p.bg.blob);
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        const blob = await db.blob(id);
        if (blob) { header.blobs.push({ id, size: blob.size, type: blob.type }); parts.push(blob); }
      }
    }
  }
  const json = new TextEncoder().encode(JSON.stringify(header));
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, json.length, true);
  return new Blob([MAGIC, len, json, ...parts], { type: 'application/octet-stream' });
}

export async function isBackup(file: Blob): Promise<boolean> {
  return (await file.slice(0, 4).text()) === MAGIC;
}

/** Restores notebooks from a backup file as new copies (nothing existing is overwritten). Returns how many. */
export async function importBackup(file: Blob): Promise<number> {
  if (!(await isBackup(file))) throw new Error('Not a Notesgood backup file');
  const len = new DataView(await file.slice(4, 8).arrayBuffer()).getUint32(0, true);
  const header = JSON.parse(await file.slice(8, 8 + len).text()) as Header;
  if (header.v !== 1) throw new Error('This backup was made by a newer version of Notesgood');

  const ids = new Map<string, string>();
  const map = (id: string) => { let n = ids.get(id); if (!n) ids.set(id, (n = uid())); return n; };

  let off = 8 + len;
  for (const b of header.blobs) {
    await db.putBlob(map(b.id), file.slice(off, off + b.size, b.type || 'application/pdf'));
    off += b.size;
  }
  const pages: Page[] = header.pages.map((p) => ({
    ...p,
    id: map(p.id),
    nb: map(p.nb),
    bg: p.bg.k === 'pdf' ? { ...p.bg, blob: map(p.bg.blob) } : p.bg,
    els: (p.els as any[]).map((e): El => {
      if (e.t === 'i') return { ...e, blob: map(e.blob) };
      if (e.t !== 's') return e;
      const u8 = unb64(e.p);
      return { ...e, p: new Float32Array(u8.buffer, 0, u8.byteLength >> 2) };
    }),
  }));
  for (let i = 0; i < pages.length; i += 50) await db.putPages(pages.slice(i, i + 50));
  for (const nb of header.notebooks) {
    await db.putNotebook({ ...nb, id: map(nb.id), pages: nb.pages.map(map) });
  }
  return header.notebooks.length;
}

export const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'notebook';
