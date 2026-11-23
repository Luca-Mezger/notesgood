// Transform cached layers while dragging; apply the original data once on release.
// Pictures stay below ink and retain their colours in dark mode.
import { drawImages, drawInk, unionBBox } from './render';
import type { BBox, El, ImageEl } from './types';

interface PicturePreview { original: ImageEl; canvas: HTMLCanvasElement; resolution: number; selected: boolean }

export class SelectionPreview {
  readonly ids: Set<string>;
  readonly originalBounds: BBox;
  private ink: { canvas: HTMLCanvasElement; bounds: BBox } | null = null;
  private pictures: PicturePreview[] = [];
  bounds: BBox;
  dx = 0;
  dy = 0;
  k = 1;
  rot = 0;

  constructor(parent: HTMLElement, originals: El[], private zoom: number, resolution: number, pixelBudget: number, pageElements: El[] = originals) {
    this.ids = new Set(originals.map(e => e.id));
    this.originalBounds = unionBBox(originals)!;
    this.bounds = [...this.originalBounds];
    const ink = originals.filter(e => e.t === 's' || e.t === 'h');
    const selectedPictures = new Map(originals.filter((e): e is ImageEl => e.t === 'i').map(e => [e.id, e]));
    // Keep picture stacking intact: cache the page's picture layer in its existing order,
    // while only transforming the selected pictures. Ink remains above every picture.
    const pictures = selectedPictures.size ? pageElements.filter((e): e is ImageEl => e.t === 'i') : [];
    const budget = pixelBudget / Math.max(1, pictures.length + (ink.length ? 1 : 0));
    const makeCanvas = (bounds: BBox, kind: string) => {
      const w = Math.max(1, bounds[2] - bounds[0]), h = Math.max(1, bounds[3] - bounds[1]);
      const s = Math.min(resolution, Math.sqrt(budget / (w * h)), 8192 / Math.max(w, h));
      const canvas = document.createElement('canvas');
      canvas.className = 'selection-preview ' + kind;
      canvas.width = Math.max(1, Math.ceil(w * s));
      canvas.height = Math.max(1, Math.ceil(h * s));
      canvas.style.width = w * zoom + 'px';
      canvas.style.height = h * zoom + 'px';
      canvas.getContext('2d')!.setTransform(s, 0, 0, s, -bounds[0] * s, -bounds[1] * s);
      return { canvas, resolution: s };
    };
    for (const picture of pictures) {
      const original = selectedPictures.get(picture.id) ?? picture;
      const selected = selectedPictures.has(picture.id);
      this.ids.add(picture.id);
      const bounds: BBox = [original.x, original.y, original.x + original.w, original.y + original.h];
      const layer = makeCanvas(bounds, 'pics');
      layer.canvas.dataset.selected = String(selected);
      drawImages(layer.canvas.getContext('2d')!, [original]);
      parent.insertBefore(layer.canvas, parent.querySelector('canvas.ink'));
      this.pictures.push({ original, ...layer, selected });
    }
    if (ink.length) {
      const bounds = unionBBox(ink)!;
      const { canvas } = makeCanvas(bounds, 'ink');
      drawInk(canvas.getContext('2d')!, ink);
      parent.insertBefore(canvas, parent.querySelector('.objs'));
      this.ink = { canvas, bounds };
    }
    this.update(0, 0, 1, 0, 0, 0);
  }

  update(dx: number, dy: number, k: number, ox: number, oy: number, rot: number) {
    this.dx = dx; this.dy = dy; this.k = k; this.rot = rot;
    const c = Math.cos(rot) * k, s = Math.sin(rot) * k;
    const tx = ox - c * ox + s * oy + dx, ty = oy - s * ox - c * oy + dy;
    const xs: number[] = [], ys: number[] = [];
    if (this.ink) {
      const [x0, y0, x1, y1] = this.ink.bounds;
      this.ink.canvas.style.transform = `matrix(${c},${s},${-s},${c},${(c * x0 - s * y0 + tx) * this.zoom},${(s * x0 + c * y0 + ty) * this.zoom})`;
      xs.push(c * x0 - s * y0 + tx, c * x1 - s * y0 + tx, c * x1 - s * y1 + tx, c * x0 - s * y1 + tx);
      ys.push(s * x0 + c * y0 + ty, s * x1 + c * y0 + ty, s * x1 + c * y1 + ty, s * x0 + c * y1 + ty);
    }
    for (const { original: e, canvas, selected } of this.pictures) {
      if (!selected) {
        canvas.style.transform = `translate(${e.x * this.zoom}px,${e.y * this.zoom}px)`;
        continue;
      }
      // Like xformEl, move the centre during rotation while keeping the picture upright.
      const cx = e.x + e.w / 2, cy = e.y + e.h / 2;
      const x = c * cx - s * cy + tx - e.w * k / 2, y = s * cx + c * cy + ty - e.h * k / 2;
      canvas.style.transform = `matrix(${k},0,0,${k},${x * this.zoom},${y * this.zoom})`;
      xs.push(x, x + e.w * k); ys.push(y, y + e.h * k);
    }
    this.bounds = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }

  /** Decoding can finish after a drag has started; repaint only the affected cached picture. */
  refreshImages(blob: string) {
    for (const { original, canvas, resolution: s } of this.pictures) {
      if (original.blob !== blob) continue;
      const ctx = canvas.getContext('2d')!;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(s, 0, 0, s, -original.x * s, -original.y * s);
      drawImages(ctx, [original]);
    }
  }

  remove() {
    for (const canvas of [...this.pictures.map(p => p.canvas), ...(this.ink ? [this.ink.canvas] : [])]) {
      canvas.remove();
      canvas.width = canvas.height = 0;
    }
  }
}
