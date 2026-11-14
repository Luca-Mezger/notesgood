// Small page previews for the page sidebar and notebook covers.
import { drawEls, drawPaper, PAPER_COLORS } from './render';
import { renderPdfPage, type RenderJob } from './pdf';
import { pageH, pageW, type Notebook, type Page } from './types';

/** Paints the page background synchronously (PDF area left white) and returns the scale used. */
export function paintBase(canvas: HTMLCanvasElement, page: Page, nb: Notebook, widthPx: number): number {
  const w = pageW(page, nb);
  const scale = widthPx / w;
  canvas.width = Math.round(widthPx);
  canvas.height = Math.round(pageH(page) * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  const H = pageH(page);
  if (page.bg.k === 'paper') drawPaper(ctx, 0, 0, w, H, page.bg.tpl, page.bg.color);
  else {
    drawPaper(ctx, 0, 0, w, H, nb.marginTpl, PAPER_COLORS.white);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, page.w, page.h);
    if (w > page.w) { ctx.fillStyle = 'rgba(0,0,0,0.12)'; ctx.fillRect(page.w - 0.25, 0, 0.5, H); }
    if (H > page.h) { ctx.fillStyle = 'rgba(0,0,0,0.12)'; ctx.fillRect(0, page.h - 0.25, page.w, 0.5); }
  }
  return scale;
}

function paintInk(canvas: HTMLCanvasElement, page: Page, scale: number) {
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  drawEls(ctx, page.els);
  // Text is drawn roughly; LaTeX blocks as a faint placeholder bar.
  for (const e of page.els) {
    if (e.t === 't') {
      ctx.fillStyle = e.c;
      ctx.font = `${e.fs}px system-ui, sans-serif`;
      ctx.textBaseline = 'top';
      e.text.split('\n').forEach((line, i) => ctx.fillText(line, e.x, e.y + i * e.fs * 1.35));
    } else if (e.t === 'x') {
      ctx.fillStyle = e.c;
      ctx.globalAlpha = 0.35;
      ctx.fillRect(e.x, e.y + (e.h ?? e.fs) * 0.35, e.w ?? e.fs * 4, (e.h ?? e.fs) * 0.3);
      ctx.globalAlpha = 1;
    }
  }
}

/** Renders a page preview into `canvas`. Returns a job handle if a PDF render is pending. */
export function renderThumb(canvas: HTMLCanvasElement, page: Page, nb: Notebook, widthPx: number): RenderJob | null {
  const scale = paintBase(canvas, page, nb, widthPx);
  paintInk(canvas, page, scale);
  if (page.bg.k !== 'pdf') return null;
  const job = renderPdfPage(page.bg.blob, page.bg.n, scale, 0);
  job.promise.then((pdf) => {
    if (!pdf) return;
    paintBase(canvas, page, nb, widthPx);
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(pdf, 0, 0);
    paintInk(canvas, page, scale);
  });
  return job;
}

/** Cover image (data URL) from a notebook's first page. */
export async function makeCover(page: Page, nb: Notebook): Promise<string> {
  const canvas = document.createElement('canvas');
  const job = renderThumb(canvas, page, nb, 420);
  if (job) await job.promise;
  return canvas.toDataURL('image/jpeg', 0.8);
}
