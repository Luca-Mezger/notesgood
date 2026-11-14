// pdf.js wrapper: document cache and a small render queue. Loaded lazily (it is the heaviest dependency).
import { db } from './db';

type PdfJs = typeof import('pdfjs-dist');
type Doc = import('pdfjs-dist').PDFDocumentProxy;

let lib: Promise<PdfJs> | null = null;
function pdfjs(): Promise<PdfJs> {
  return (lib ??= import('pdfjs-dist/legacy/build/pdf.mjs').then((m: any) => {
    m.GlobalWorkerOptions.workerSrc = new URL('pdfjs/pdf.worker.min.mjs', document.baseURI).href;
    return m as PdfJs;
  }));
}

const base = (p: string) => new URL('pdfjs/' + p, document.baseURI).href;

async function load(data: ArrayBuffer): Promise<Doc> {
  const m = await pdfjs();
  return m.getDocument({
    data: new Uint8Array(data),
    standardFontDataUrl: base('standard_fonts/'),
    cMapUrl: base('cmaps/'),
    cMapPacked: true,
    wasmUrl: base('wasm/'),
    iccUrl: base('iccs/'),
  }).promise;
}

const docs = new Map<string, Promise<Doc>>();

/** Opens (and caches) a PDF stored in the blob store. */
export function getDoc(blobId: string): Promise<Doc> {
  let d = docs.get(blobId);
  if (!d) {
    d = db.blob(blobId).then(async (b) => {
      if (!b) throw new Error('PDF data missing');
      return load(await b.arrayBuffer());
    });
    docs.set(blobId, d);
    d.catch(() => docs.delete(blobId));
  }
  return d;
}

export function closeDocs() {
  for (const d of docs.values()) d.then((doc) => doc.loadingTask.destroy()).catch(() => {});
  docs.clear();
}

/** Reads page sizes (in points, rotation applied) of a PDF file. */
export async function pdfPageSizes(data: ArrayBuffer): Promise<[number, number][]> {
  const doc = await load(data.slice(0));
  const out: [number, number][] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const vp = (await doc.getPage(i)).getViewport({ scale: 1 });
    out.push([vp.width, vp.height]);
  }
  await doc.loadingTask.destroy();
  return out;
}

export interface RenderJob { promise: Promise<HTMLCanvasElement | null>; cancel(): void }

interface Queued { run: () => Promise<void>; cancelled: boolean; prio: number }
const queue: Queued[] = [];
let running = 0;

function pump() {
  while (running < 2 && queue.length) {
    // Highest priority first; among equals, the most recent request (what the user looks at now).
    let best = queue.length - 1;
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i].prio > queue[best].prio) best = i;
    const job = queue.splice(best, 1)[0];
    if (job.cancelled) continue;
    running++;
    job.run().finally(() => { running--; pump(); });
  }
}

/** Renders one PDF page to a new canvas at `scale` device pixels per point. Resolves null if cancelled. */
export function renderPdfPage(blobId: string, n: number, scale: number, prio = 1, background = false): RenderJob {
  let task: { cancel(): void } | null = null;
  let resolve!: (c: HTMLCanvasElement | null) => void;
  const promise = new Promise<HTMLCanvasElement | null>((r) => (resolve = r));
  const q: Queued = {
    cancelled: false,
    prio,
    run: async () => {
      try {
        const doc = await getDoc(blobId);
        const page = await doc.getPage(n);
        if (q.cancelled) return resolve(null);
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(viewport.width));
        canvas.height = Math.max(1, Math.round(viewport.height));
        // PDF.js display rendering waits for animation frames, which stop in hidden windows.
        // Covers use its offscreen print scheduler so automatic imports can finish in the background.
        const rt = page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport, intent: background ? 'print' : 'display' } as any);
        task = rt;
        await rt.promise;
        resolve(q.cancelled ? null : canvas);
      } catch (e: any) {
        if (e?.name !== 'RenderingCancelledException') console.warn('PDF render failed', e);
        resolve(null);
      }
    },
  };
  queue.push(q);
  pump();
  return { promise, cancel: () => { q.cancelled = true; task?.cancel(); resolve(null); } };
}

// ---------- text lines (for snapping underlines and highlights to the printed text) ----------

/** One line of printed text, in page points with a top-left origin. */
export interface TextLine { x1: number; x2: number; base: number; size: number }

const lineCache = new Map<string, Promise<TextLine[]>>();

/** Horizontal text lines of a PDF page, merged from pdf.js text items. Cached per page. */
export function pdfTextLines(blobId: string, n: number): Promise<TextLine[]> {
  const key = blobId + '/' + n;
  let p = lineCache.get(key);
  if (!p) {
    p = (async () => {
      const m = await pdfjs();
      const page = await (await getDoc(blobId)).getPage(n);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      const glyphs: TextLine[] = [];
      for (const it of tc.items as any[]) {
        if (!it.str || !it.str.trim() || !it.transform) continue;
        const t = m.Util.transform(vp.transform, it.transform);
        // Only horizontal text; rotated runs are skipped.
        if (Math.abs(t[1]) > 0.01 || Math.abs(t[2]) > 0.01) continue;
        const size = Math.hypot(t[2], t[3]);
        const w = it.width * vp.scale;
        if (size < 2 || w <= 0) continue;
        glyphs.push({ x1: t[4], x2: t[4] + w, base: t[5], size });
      }
      // Merge items that share a baseline into lines.
      glyphs.sort((a, b) => a.base - b.base || a.x1 - b.x1);
      const lines: TextLine[] = [];
      for (const g of glyphs) {
        const l = lines[lines.length - 1];
        if (l && Math.abs(l.base - g.base) < Math.max(1.5, l.size * 0.25) && g.x1 < l.x2 + l.size * 3) {
          l.x1 = Math.min(l.x1, g.x1); l.x2 = Math.max(l.x2, g.x2); l.size = Math.max(l.size, g.size);
        } else lines.push({ ...g });
      }
      return lines;
    })();
    lineCache.set(key, p);
    p.catch(() => lineCache.delete(key));
  }
  return p;
}

export function clearTextLines() { lineCache.clear(); }
