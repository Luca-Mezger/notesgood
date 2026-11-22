// During an ink transform, move a cached canvas rather than rewriting stroke samples.
// The original vector data is applied once on release, so the final render stays sharp.
import { drawInk, unionBBox } from './render';
import type { BBox, El } from './types';

export class InkSelectionPreview {
  readonly canvas = document.createElement('canvas');
  readonly ids: Set<string>;
  readonly originalBounds: BBox;
  bounds: BBox;
  dx = 0;
  dy = 0;
  k = 1;
  rot = 0;

  constructor(parent: HTMLElement, originals: El[], private zoom: number, resolution: number, pixelBudget: number) {
    this.ids = new Set(originals.map(e => e.id));
    this.originalBounds = unionBBox(originals)!;
    this.bounds = [...this.originalBounds];
    const [x0, y0, x1, y1] = this.originalBounds;
    const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
    const s = Math.min(resolution, Math.sqrt(pixelBudget / (w * h)), 8192 / Math.max(w, h));
    this.canvas.className = 'selection-preview ink';
    this.canvas.width = Math.max(1, Math.ceil(w * s));
    this.canvas.height = Math.max(1, Math.ceil(h * s));
    this.canvas.style.width = w * zoom + 'px';
    this.canvas.style.height = h * zoom + 'px';
    const ctx = this.canvas.getContext('2d')!;
    ctx.setTransform(s, 0, 0, s, -x0 * s, -y0 * s);
    drawInk(ctx, originals);
    parent.append(this.canvas);
    this.update(0, 0, 1, 0, 0, 0);
  }

  update(dx: number, dy: number, k: number, ox: number, oy: number, rot: number) {
    this.dx = dx; this.dy = dy; this.k = k; this.rot = rot;
    const c = Math.cos(rot) * k, s = Math.sin(rot) * k;
    const tx = ox - c * ox + s * oy + dx, ty = oy - s * ox - c * oy + dy;
    const [x0, y0, x1, y1] = this.originalBounds;
    this.canvas.style.transform = `matrix(${c},${s},${-s},${c},${(c * x0 - s * y0 + tx) * this.zoom},${(s * x0 + c * y0 + ty) * this.zoom})`;
    const xs = [c * x0 - s * y0 + tx, c * x1 - s * y0 + tx, c * x1 - s * y1 + tx, c * x0 - s * y1 + tx];
    const ys = [s * x0 + c * y0 + ty, s * x1 + c * y0 + ty, s * x1 + c * y1 + ty, s * x0 + c * y1 + ty];
    this.bounds = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }

  remove() {
    this.canvas.remove();
    // Release the backing store immediately rather than waiting for garbage collection.
    this.canvas.width = this.canvas.height = 0;
  }
}
