// Canvas drawing and geometry for ink strokes, shapes and paper templates.
import type { BBox, El, LineStyle, Ruling, Shape, Stroke, Tpl } from './types';
import { paperMetrics, uid } from './types';
import { db } from './db';

export const HL_ALPHA = 0.38;

/** Line width of a pen stroke of nominal size `s` at pressure `p` (0..1). p = 0.5 gives exactly `s`. */
export const penW = (s: number, p: number) => s * (0.4 + 1.2 * p);

/**
 * Draws a stroke from point index `from` on. Calling it repeatedly with growing `n` draws
 * incrementally (used for the live stroke): pass the previous `n - 1` as `from`.
 * Pen strokes vary in width with pressure; consecutive segments of similar width are batched
 * into one path so that redrawing a full page stays cheap.
 */
export function drawStroke(
  ctx: CanvasRenderingContext2D, k: 'pen' | 'hl', color: string, s: number,
  p: ArrayLike<number>, n: number, from = 0, style?: LineStyle,
) {
  if (n < 1) return;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = ctx.fillStyle = color;

  if (n === 1 && k === 'pen') {
    ctx.beginPath();
    ctx.arc(p[0], p[1], penW(s, p[2]) / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  if (k === 'hl' || (style && style !== 'solid')) {
    ctx.setLineDash(lineDash(style, s));
    // Constant width, one path, so the translucent ink does not darken where segments overlap.
    ctx.globalAlpha = k === 'hl' ? HL_ALPHA : 1;
    ctx.lineWidth = s;
    ctx.beginPath();
    ctx.moveTo(p[0], p[1]);
    for (let i = 1; i < n - 1; i++) {
      const a = i * 3, b = a + 3;
      ctx.quadraticCurveTo(p[a], p[a + 1], (p[a] + p[b]) / 2, (p[a + 1] + p[b + 1]) / 2);
    }
    const l = (n - 1) * 3;
    ctx.lineTo(p[l], p[l + 1]);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
    return;
  }


  let i = Math.max(1, from);
  let sx: number, sy: number;
  if (i === 1) { sx = p[0]; sy = p[1]; }
  else { const a = (i - 1) * 3, b = i * 3; sx = (p[a] + p[b]) / 2; sy = (p[a + 1] + p[b + 1]) / 2; }
  let bw = penW(s, p[i * 3 + 2]);
  ctx.lineWidth = bw;
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  for (; i < n - 1; i++) {
    const a = i * 3, b = a + 3;
    const w = penW(s, p[a + 2]);
    if (Math.abs(w - bw) > bw * 0.07) {
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineWidth = bw = w;
    }
    sx = (p[a] + p[b]) / 2;
    sy = (p[a + 1] + p[b + 1]) / 2;
    ctx.quadraticCurveTo(p[a], p[a + 1], sx, sy);
  }
  const l = (n - 1) * 3;
  ctx.lineTo(p[l], p[l + 1]);
  ctx.stroke();
}

function shapePath(ctx: CanvasRenderingContext2D, k: Shape['k'], x1: number, y1: number, x2: number, y2: number, s: number) {
  ctx.beginPath();
  if (k === 'rect') ctx.rect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
  else if (k === 'ellipse') ctx.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2);
  else {
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    if (k === 'arrow') {
      const a = Math.atan2(y2 - y1, x2 - x1), len = Math.max(8, s * 4.5);
      ctx.moveTo(x2 - len * Math.cos(a - 0.45), y2 - len * Math.sin(a - 0.45));
      ctx.lineTo(x2, y2);
      ctx.lineTo(x2 - len * Math.cos(a + 0.45), y2 - len * Math.sin(a + 0.45));
    }
  }
}

export function lineDash(style: LineStyle | undefined, width: number): number[] {
  return style === 'dashed' ? [width * 4, width * 3] : style === 'dotted' ? [0, width * 2.5] : [];
}

export function drawShape(ctx: CanvasRenderingContext2D, k: Shape['k'], c: string, s: number, x1: number, y1: number, x2: number, y2: number, style?: LineStyle) {
  ctx.setLineDash(lineDash(style, s));
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = c;
  ctx.lineWidth = s;
  shapePath(ctx, k, x1, y1, x2, y2, s);
  ctx.stroke();
  ctx.setLineDash([]);
}

// ---------- images ----------
const images = new Map<string, ImageBitmap | null>(); // null = loading or failed
const imageListeners = new Set<(blob: string) => void>();
/** Calls `fn` whenever a picture finishes decoding, so pages showing it can redraw. Returns an unsubscribe function. */
export function onImageReady(fn: (blob: string) => void): () => void {
  imageListeners.add(fn);
  return () => imageListeners.delete(fn);
}
export function cacheImage(blob: string, bmp: ImageBitmap) { images.set(blob, bmp); }
function getImage(blob: string): ImageBitmap | null {
  const hit = images.get(blob);
  if (hit !== undefined) return hit;
  images.set(blob, null);
  db.blob(blob).then((b) => (b ? createImageBitmap(b) : null)).then((bmp) => {
    if (!bmp) return;
    images.set(blob, bmp);
    for (const fn of imageListeners) fn(blob);
  }).catch(() => {});
  return null;
}

/** Draws the pictures of a page (they always sit beneath the ink). */
export function drawImages(ctx: CanvasRenderingContext2D, els: El[]) {
  for (const e of els) {
    if (e.t !== 'i') continue;
    const bmp = getImage(e.blob);
    if (bmp) ctx.drawImage(bmp, e.x, e.y, e.w, e.h);
    else { ctx.fillStyle = 'rgba(0,0,0,0.06)'; ctx.fillRect(e.x, e.y, e.w, e.h); }
  }
}

/** Draws pictures, then strokes and shapes. Text and LaTeX live in the DOM. */
export function drawEls(ctx: CanvasRenderingContext2D, els: El[]) {
  drawImages(ctx, els);
  drawInk(ctx, els);
}

/** Strokes and shapes only. */
export function drawInk(ctx: CanvasRenderingContext2D, els: El[]) {
  for (const e of els) {
    if (e.t === 's') drawStroke(ctx, e.k, e.c, e.s, e.p, e.p.length / 3, 0, e.style);
    else if (e.t === 'h') drawShape(ctx, e.k, e.c, e.s, e.x1, e.y1, e.x2, e.y2, e.style);
  }
}

export const PAPER_COLORS: Record<string, string> = { white: '#ffffff', cream: '#fbf6e6' };

/** Fills a paper area with its ruling. */
export function drawPaper(ctx: CanvasRenderingContext2D, x0: number, y0: number, w: number, h: number, tpl: Tpl, color: string, ruling?: Ruling) {
  ctx.fillStyle = color;
  ctx.fillRect(x0, y0, w, h);
  if (tpl === 'blank') return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, y0, w, h);
  ctx.clip();
  const { spacing: g, weight } = paperMetrics(tpl, ruling);
  const rule = 'rgba(60, 90, 140, 0.22)';
  if (tpl === 'lined') {
    ctx.strokeStyle = rule; ctx.lineWidth = weight; ctx.beginPath();
    for (let y = y0 + 56; y < y0 + h - 16; y += g) { ctx.moveTo(x0, y); ctx.lineTo(x0 + w, y); }
    ctx.stroke();
  } else if (tpl === 'grid') {
    ctx.strokeStyle = rule; ctx.lineWidth = weight; ctx.beginPath();
    for (let x = x0 + g; x < x0 + w; x += g) { ctx.moveTo(x, y0); ctx.lineTo(x, y0 + h); }
    for (let y = y0 + g; y < y0 + h; y += g) { ctx.moveTo(x0, y); ctx.lineTo(x0 + w, y); }
    ctx.stroke();
  } else if (tpl === 'dots') {
    ctx.fillStyle = 'rgba(60, 90, 140, 0.4)';
    for (let x = x0 + g; x < x0 + w; x += g) for (let y = y0 + g; y < y0 + h; y += g) ctx.fillRect(x - weight / 2, y - weight / 2, weight, weight);
  }
  ctx.restore();
}

// ---------- geometry ----------

export function strokeBBox(p: ArrayLike<number>, s: number): BBox {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    if (p[i] < x0) x0 = p[i]; if (p[i] > x1) x1 = p[i];
    if (p[i + 1] < y0) y0 = p[i + 1]; if (p[i + 1] > y1) y1 = p[i + 1];
  }
  return [x0 - s, y0 - s, x1 + s, y1 + s];
}

export function elBBox(e: El): BBox {
  if (e.t === 's') return e.bb;
  if (e.t === 'h') return [Math.min(e.x1, e.x2) - e.s, Math.min(e.y1, e.y2) - e.s, Math.max(e.x1, e.x2) + e.s, Math.max(e.y1, e.y2) + e.s];
  if (e.t === 'i') return [e.x, e.y, e.x + e.w, e.y + e.h];
  return [e.x, e.y, e.x + (e.w ?? 40), e.y + (e.h ?? e.fs * 1.4)];
}

function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + t * dx - px, cy = ay + t * dy - py;
  return cx * cx + cy * cy;
}

/** Outline of a shape as a polyline (flat x, y pairs), for hit-testing and lasso. */
export function shapePoly(e: Shape): number[] {
  const { x1, y1, x2, y2 } = e;
  if (e.k === 'rect') return [x1, y1, x2, y1, x2, y2, x1, y2, x1, y1];
  if (e.k === 'ellipse') {
    const out: number[] = [], cx = (x1 + x2) / 2, cy = (y1 + y2) / 2, rx = Math.abs(x2 - x1) / 2, ry = Math.abs(y2 - y1) / 2;
    for (let i = 0; i <= 40; i++) { const a = (i / 40) * Math.PI * 2; out.push(cx + rx * Math.cos(a), cy + ry * Math.sin(a)); }
    return out;
  }
  return [x1, y1, x2, y2];
}

/** True if the point is within radius r of the element's ink (or inside its box for text/LaTeX). */
export function hitEl(e: El, x: number, y: number, r: number): boolean {
  const bb = elBBox(e);
  if (x < bb[0] - r || x > bb[2] + r || y < bb[1] - r || y > bb[3] + r) return false;
  if (e.t === 't' || e.t === 'x' || e.t === 'i') return true;
  if (e.t === 's') {
    const p = e.p, n = p.length / 3;
    const rr = r + e.s / 2, r2 = rr * rr;
    if (n === 1) return (p[0] - x) ** 2 + (p[1] - y) ** 2 <= r2;
    for (let i = 3; i < p.length; i += 3) if (segDist2(x, y, p[i - 3], p[i - 2], p[i], p[i + 1]) <= r2) return true;
    return false;
  }
  const poly = shapePoly(e), rr = r + e.s / 2, r2 = rr * rr;
  for (let i = 2; i < poly.length; i += 2) if (segDist2(x, y, poly[i - 2], poly[i - 1], poly[i], poly[i + 1]) <= r2) return true;
  return false;
}

export function inPoly(x: number, y: number, poly: number[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    const xi = poly[i], yi = poly[i + 1], xj = poly[j], yj = poly[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** True when two segments cross or their painted edges touch within radius r. */
function segmentsTouch(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number, r: number): boolean {
  if (Math.max(ax, bx) + r < Math.min(cx, dx) || Math.max(cx, dx) + r < Math.min(ax, bx) ||
      Math.max(ay, by) + r < Math.min(cy, dy) || Math.max(cy, dy) + r < Math.min(ay, by)) return false;
  const c1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const c2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  const c3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const c4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  if (((c1 > 0 && c2 < 0) || (c1 < 0 && c2 > 0)) && ((c3 > 0 && c4 < 0) || (c3 < 0 && c4 > 0))) return true;
  const rr = r * r;
  return segDist2(ax, ay, cx, cy, dx, dy) <= rr || segDist2(bx, by, cx, cy, dx, dy) <= rr ||
    segDist2(cx, cy, ax, ay, bx, by) <= rr || segDist2(dx, dy, ax, ay, bx, by) <= rr;
}

/** Any enclosed or crossed ink selects its entire stroke; boxes still use their centre. */
export function elInPoly(e: El, poly: number[]): boolean {
  if (poly.length < 4) return false;
  if (e.t === 't' || e.t === 'x' || e.t === 'i') { const b = elBBox(e); return inPoly((b[0] + b[2]) / 2, (b[1] + b[3]) / 2, poly); }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < poly.length; i += 2) {
    x0 = Math.min(x0, poly[i]); y0 = Math.min(y0, poly[i + 1]);
    x1 = Math.max(x1, poly[i]); y1 = Math.max(y1, poly[i + 1]);
  }
  const bb = elBBox(e);
  if (bb[2] < x0 || bb[0] > x1 || bb[3] < y0 || bb[1] > y1) return false;
  let pts: ArrayLike<number>, step: number;
  if (e.t === 's') { pts = e.p; step = 3; } else { pts = shapePoly(e); step = 2; }
  for (let i = 0; i < pts.length; i += step) {
    const x = pts[i], y = pts[i + 1], prev = Math.max(0, i - step);
    if (inPoly(x, y, poly)) return true;
    const radius = e.t === 's' && e.k === 'pen' ? Math.max(penW(e.s, pts[i + 2]), penW(e.s, pts[prev + 2])) / 2 : e.s / 2;
    for (let j = 0, k = poly.length - 2; j < poly.length; k = j, j += 2) {
      if (segmentsTouch(pts[prev], pts[prev + 1], x, y, poly[k], poly[k + 1], poly[j], poly[j + 1], radius)) return true;
    }
  }
  return false;
}

export function cloneEl<T extends El>(e: T, newId = false): T {
  const c: any = { ...e };
  if (e.t === 's') { c.p = new Float32Array(e.p); c.bb = [...e.bb]; }
  if (newId) c.id = uid();
  return c;
}

/**
 * Writes `src` transformed into `dst` in place: scale k and rotation `rot` (radians) about (ox, oy),
 * then translate by dx, dy. Text, formulas and pictures are not rotated themselves; their centre moves.
 */
export function xformEl(src: El, dst: El, dx: number, dy: number, k = 1, ox = 0, oy = 0, rot = 0) {
  const c = Math.cos(rot), s = Math.sin(rot);
  const X = (x: number, y: number) => ox + ((x - ox) * c - (y - oy) * s) * k + dx;
  const Y0 = (x: number, y: number) => oy + ((x - ox) * s + (y - oy) * c) * k + dy;
  if (rot && (src.t === 't' || src.t === 'x' || src.t === 'i') && (dst.t === 't' || dst.t === 'x' || dst.t === 'i')) {
    const b = elBBox(src), mx = (b[0] + b[2]) / 2, my = (b[1] + b[3]) / 2;
    const nx = X(mx, my), ny = Y0(mx, my), w = (b[2] - b[0]) * k, h = (b[3] - b[1]) * k;
    dst.x = nx - w / 2; dst.y = ny - h / 2;
    if (src.t === 'i' && dst.t === 'i') { dst.w = src.w * k; dst.h = src.h * k; }
    else if ((src.t === 't' || src.t === 'x') && (dst.t === 't' || dst.t === 'x')) { dst.fs = src.fs * k; if (src.w != null) dst.w = src.w * k; if (src.h != null) dst.h = src.h * k; }
    return;
  }
  const XY = { x: 0, y: 0 };
  const T = (x: number, y: number) => { XY.x = X(x, y); XY.y = Y0(x, y); return XY; };
  if (src.t === 's' && dst.t === 's') {
    const a = src.p, b = dst.p;
    for (let i = 0; i < a.length; i += 3) { const q = T(a[i], a[i + 1]); b[i] = q.x; b[i + 1] = q.y; b[i + 2] = a[i + 2]; }
    dst.s = src.s * k;
    dst.bb = strokeBBox(b, dst.s);
  } else if (src.t === 'h' && dst.t === 'h') {
    let q = T(src.x1, src.y1); dst.x1 = q.x; dst.y1 = q.y;
    q = T(src.x2, src.y2); dst.x2 = q.x; dst.y2 = q.y; dst.s = src.s * k;
  } else if (src.t === 'i' && dst.t === 'i') {
    const q = T(src.x, src.y); dst.x = q.x; dst.y = q.y; dst.w = src.w * k; dst.h = src.h * k;
  } else if ((src.t === 't' || src.t === 'x') && (dst.t === 't' || dst.t === 'x')) {
    const q = T(src.x, src.y); dst.x = q.x; dst.y = q.y; dst.fs = src.fs * k;
    if (src.w != null) dst.w = src.w * k;
    if (src.h != null) dst.h = src.h * k;
  }
}

export function unionBBox(els: Iterable<El>): BBox | null {
  let b: BBox | null = null;
  for (const e of els) {
    const bb = elBBox(e);
    if (!b) b = [...bb] as BBox;
    else { b[0] = Math.min(b[0], bb[0]); b[1] = Math.min(b[1], bb[1]); b[2] = Math.max(b[2], bb[2]); b[3] = Math.max(b[3], bb[3]); }
  }
  return b;
}

export function makeStroke(k: 'pen' | 'hl', c: string, s: number, pts: number[], style?: LineStyle): Stroke {
  const p = new Float32Array(pts);
  return { t: 's', id: uid(), k, c, s, p, bb: strokeBBox(p, s), ...(style && style !== 'solid' ? { style } : {}) };
}

// ---------- hold-to-snap shape recognition ----------

export type Snap =
  | { k: 'line' | 'rect' | 'ellipse'; x1: number; y1: number; x2: number; y2: number }
  | { k: 'poly'; v: number[] }; // closed polygon, flat x, y vertices

/** Ramer-Douglas-Peucker on x, y, pressure triplets; returns indices of the kept points. */
function simplify(p: number[], tol: number): number[] {
  const n = p.length / 3, keep = new Uint8Array(n), stack: [number, number][] = [[0, n - 1]];
  keep[0] = keep[n - 1] = 1;
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = 0, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = segDist2(p[i * 3], p[i * 3 + 1], p[a * 3], p[a * 3 + 1], p[b * 3], p[b * 3 + 1]);
      if (d > worst) { worst = d; idx = i; }
    }
    if (idx >= 0 && worst > tol * tol) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

/** Snaps a nearly horizontal or vertical segment exactly onto the axis. */
export function axisSnap(x1: number, y1: number, x2: number, y2: number, deg = 4): [number, number] {
  const a = Math.abs(Math.atan2(y2 - y1, x2 - x1)) * 180 / Math.PI;
  if (a < deg || a > 180 - deg) return [x2, y1];
  if (Math.abs(a - 90) < deg) return [x1, y2];
  return [x2, y2];
}

/** Guesses the clean shape a freehand stroke was meant to be: a line, rectangle, ellipse, triangle or quadrilateral. */
export function recognize(p: number[], minSize: number): Snap | null {
  const n = p.length / 3;
  if (n < 4) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, len = 0;
  for (let i = 0; i < p.length; i += 3) {
    x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); y0 = Math.min(y0, p[i + 1]); y1 = Math.max(y1, p[i + 1]);
    if (i) len += Math.hypot(p[i] - p[i - 3], p[i + 1] - p[i - 2]);
  }
  const w = x1 - x0, h = y1 - y0, diag = Math.hypot(w, h);
  if (diag < minSize) return null;
  const l = p.length - 3;
  const sx = p[0], sy = p[1], ex = p[l], ey = p[l + 1], gap = Math.hypot(ex - sx, ey - sy);

  if (!(gap < 0.25 * diag && len > 1.8 * diag)) {
    // Open stroke: a line if it never strays far from its chord.
    if (len > 1.2 * gap) return null;
    let dev = 0;
    for (let i = 3; i < l; i += 3) dev = Math.max(dev, segDist2(p[i], p[i + 1], sx, sy, ex, ey));
    if (Math.sqrt(dev) > Math.max(0.07 * gap, minSize * 0.1)) return null;
    const [ax, ay] = axisSnap(sx, sy, ex, ey);
    return { k: 'line', x1: sx, y1: sy, x2: ax, y2: ay };
  }

  // Closed stroke: how well does it follow the ellipse inscribed in its bounding box?
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = Math.max(w / 2, 0.01), ry = Math.max(h / 2, 0.01);
  let errE = 0;
  for (let i = 0; i < p.length; i += 3) errE += Math.abs(Math.hypot((p[i] - cx) / rx, (p[i + 1] - cy) / ry) - 1);
  errE /= n;
  const box: Snap = { k: 'ellipse', x1: x0, y1: y0, x2: x1, y2: y1 };
  if (errE < 0.085) return box;

  // Otherwise count corners.
  const idx = simplify(p, 0.07 * diag);
  let v = idx.slice(0, -1).map((i) => [p[i * 3], p[i * 3 + 1]]);
  if (v.length >= 3) {
    // The stroke may start mid-edge: drop the start vertex if the outline runs straight through it.
    const a = v[v.length - 1], b = v[0], c = v[1];
    const cos = ((b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1])) / ((Math.hypot(b[0] - a[0], b[1] - a[1]) * Math.hypot(c[0] - b[0], c[1] - b[1])) || 1);
    if (cos > 0.86) v = v.slice(1);
  }
  if (v.length === 4) {
    const aligned = v.every((q, i) => {
      const r = v[(i + 1) % 4];
      const a = Math.abs(Math.atan2(r[1] - q[1], r[0] - q[0])) * 180 / Math.PI % 90;
      return a < 14 || a > 76;
    });
    return aligned ? { k: 'rect', x1: x0, y1: y0, x2: x1, y2: y1 } : { k: 'poly', v: v.flat() };
  }
  if (v.length === 3) return { k: 'poly', v: v.flat() };
  return errE < 0.16 ? box : null;
}

/** A closed polygon as a pen stroke. Each vertex is doubled so that corners stay sharp. */
export function polyStroke(c: string, s: number, v: number[]): Stroke {
  const pts: number[] = [];
  for (let i = 0; i <= v.length; i += 2) {
    const j = i % v.length;
    pts.push(v[j], v[j + 1], 0.5, v[j], v[j + 1], 0.5);
  }
  return makeStroke('pen', c, s, pts);
}

/** A rectangle or ellipse as a pen stroke, so it can be rotated freely. */
export function shapeToStroke(e: Shape): Stroke {
  const poly = shapePoly(e);
  const pts: number[] = [];
  for (let i = 0; i < poly.length; i += 2) {
    pts.push(poly[i], poly[i + 1], 0.5);
    if (e.k === 'rect') pts.push(poly[i], poly[i + 1], 0.5); // doubled vertices keep the corners sharp
  }
  const st = makeStroke('pen', e.c, e.s, pts, e.style);
  st.id = e.id;
  return st;
}

/**
 * Partial eraser: removes the parts of a stroke within radius r of (x, y).
 * Returns null if the stroke was not touched, otherwise the remaining pieces (possibly none).
 */
export function eraseFromStroke(st: Stroke, x: number, y: number, r: number): Stroke[] | null {
  const p = st.p, n = p.length / 3;
  const rr = r + st.s * 0.5, r2 = rr * rr;
  const bb = st.bb;
  if (x < bb[0] - r || x > bb[2] + r || y < bb[1] - r || y > bb[3] + r) return null;
  if (n === 1) return (p[0] - x) ** 2 + (p[1] - y) ** 2 <= r2 ? [] : null;
  // Mark points to drop: those inside the circle, plus insert cut points where a segment crosses it.
  const keep: number[][] = [];
  let cur: number[] = [];
  let touched = false;
  const inside = (i: number) => (p[i * 3] - x) ** 2 + (p[i * 3 + 1] - y) ** 2 <= r2;
  let prevIn = inside(0);
  if (!prevIn) cur.push(p[0], p[1], p[2]); else touched = true;
  for (let i = 1; i < n; i++) {
    const nowIn = inside(i);
    const ax = p[i * 3 - 3], ay = p[i * 3 - 2], bx = p[i * 3], by = p[i * 3 + 1];
    if (prevIn !== nowIn || (!prevIn && !nowIn && segDist2(x, y, ax, ay, bx, by) <= r2)) {
      touched = true;
      // Intersections of the segment with the circle, as parameters t in [0, 1].
      const dx = bx - ax, dy = by - ay, fx = ax - x, fy = ay - y;
      const A = dx * dx + dy * dy, B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - r2;
      const D = B * B - 4 * A * C;
      const ts: number[] = [];
      if (D >= 0 && A > 0) { const sq = Math.sqrt(D); for (const t of [(-B - sq) / (2 * A), (-B + sq) / (2 * A)]) if (t > 0 && t < 1) ts.push(t); }
      const pt = (t: number) => [ax + dx * t, ay + dy * t, p[i * 3 - 1] + (p[i * 3 + 2] - p[i * 3 - 1]) * t];
      if (!prevIn && !nowIn && ts.length === 2) {
        cur.push(...pt(ts[0])); keep.push(cur); cur = [...pt(ts[1])];
      } else if (!prevIn && nowIn) {
        if (ts.length) cur.push(...pt(ts[0]));
        keep.push(cur); cur = [];
      } else if (prevIn && !nowIn) {
        cur = ts.length ? [...pt(ts[ts.length - 1])] : [];
      }
    }
    if (!nowIn) cur.push(bx, by, p[i * 3 + 2]);
    prevIn = nowIn;
  }
  keep.push(cur);
  if (!touched) return null;
  return keep.filter((k) => k.length >= 6 || (k.length === 3 && st.k === 'pen' && false)).map((k) => makeStroke(st.k, st.c, st.s, k, st.style));
}
