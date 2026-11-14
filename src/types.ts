// Data model. All coordinates are in page points (1/72 inch), origin top-left of the page.

export type Tpl = 'blank' | 'lined' | 'grid' | 'dots';
export type BBox = [number, number, number, number]; // x0, y0, x1, y1

/** Ink stroke. `p` holds x, y, pressure triplets. */
export interface Stroke { t: 's'; id: string; k: 'pen' | 'hl'; c: string; s: number; p: Float32Array; bb: BBox }
export type ShapeKind = 'line' | 'arrow' | 'rect' | 'ellipse';
export interface Shape { t: 'h'; id: string; k: ShapeKind; c: string; s: number; x1: number; y1: number; x2: number; y2: number }
/** Text box. `$...$` inside the text is rendered as inline LaTeX. w/h are measured at render time. */
export interface TextEl { t: 't'; id: string; x: number; y: number; c: string; fs: number; text: string; w?: number; h?: number }
/** Display-style LaTeX block. */
export interface TexEl { t: 'x'; id: string; x: number; y: number; c: string; fs: number; src: string; w?: number; h?: number }
/** Pasted or inserted picture; the bitmap lives in the blob store. Always drawn beneath the ink. */
export interface ImageEl { t: 'i'; id: string; x: number; y: number; w: number; h: number; blob: string; /** locked pictures cannot be selected or moved */ lock?: boolean }
export type El = Stroke | Shape | TextEl | TexEl | ImageEl;

export type Bg =
  | { k: 'paper'; tpl: Tpl; color: string }
  | { k: 'pdf'; blob: string; n: number }; // n = 1-based page number in the PDF

/** For PDF pages, w/h is the size of the PDF page itself; the side margin is added on top (see pageW). */
export interface Page { id: string; nb: string; w: number; h: number; bg: Bg; els: El[]; /** last change (ms), used by sync */ u?: number; /** extra height added below the original page (points) */ ext?: number }

export interface Notebook {
  id: string;
  title: string;
  folder: string; // '' = none
  fav: boolean;
  created: number;
  updated: number;
  pages: string[]; // ordered page ids
  /** Extra writing space right of each PDF page, as a fraction of the PDF page width. */
  margin: number;
  marginTpl: Tpl;
  /** Template used for newly added pages. */
  tpl: Tpl;
  paper: string;
  cover?: string; // data URL
}

/** Full page height including any space added below. */
export function pageH(p: Page): number {
  return p.h + (p.ext ?? 0);
}

/** Full page width including the PDF side margin. */
export function pageW(p: Page, nb: Notebook): number {
  return p.bg.k === 'pdf' ? p.w * (1 + nb.margin) : p.w;
}

export function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
}
