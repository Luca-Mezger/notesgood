// AI drawings are standalone SVG images, never active markup in the notebook DOM.
export const isGraphic = (src: string) => /^\s*<svg(?:\s|>)/i.test(src);

const tags = new Set('svg g path rect circle ellipse line polyline polygon text tspan defs marker clipPath linearGradient radialGradient stop title desc'.split(' '));
const attrs = new Set(('xmlns viewBox width height x y x1 y1 x2 y2 cx cy r rx ry d points transform fill fill-opacity fill-rule ' +
  'stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin stroke-dasharray stroke-dashoffset opacity ' +
  'font-family font-size font-weight font-style text-anchor dominant-baseline dx dy id ' +
  'marker-start marker-mid marker-end markerWidth markerHeight markerUnits refX refY orient ' +
  'clip-path clip-rule gradientUnits gradientTransform offset stop-color stop-opacity').split(' '));

/** Reject active/external content, and give the drawing predictable intrinsic dimensions. */
export function graphicSource(src: string): { src: string; width: number; height: number } {
  if (src.length > 200_000 || /<!DOCTYPE|<!ENTITY|<\?/i.test(src)) throw Error('The graphic is too large or contains unsupported markup.');
  const doc = new DOMParser().parseFromString(src, 'image/svg+xml');
  const root = doc.documentElement;
  if (doc.querySelector('parsererror') || root.localName !== 'svg') throw Error('Enter a complete SVG drawing with a viewBox.');
  for (const el of [root, ...root.querySelectorAll('*')]) {
    if (!tags.has(el.localName) || (el.namespaceURI && el.namespaceURI !== 'http://www.w3.org/2000/svg')) throw Error('Use only SVG shapes and text for graphics.');
    for (const a of [...el.attributes]) {
      if (!attrs.has(a.name) || (/url\s*\(/i.test(a.value) && !/^url\(#[\w-]+\)$/.test(a.value))) throw Error('Graphics cannot contain scripts, links, styles or external resources.');
    }
  }
  const box = root.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
  if (!box || box.length !== 4 || !box.every(Number.isFinite) || box[2] <= 0 || box[3] <= 0 || box[2] > 100_000 || box[3] > 100_000 || box[3] / box[2] < 0.1 || box[3] / box[2] > 10) throw Error('The graphic needs a valid viewBox with a reasonable aspect ratio.');
  root.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  root.setAttribute('width', String(box[2]));
  root.setAttribute('height', String(box[3]));
  return { src: new XMLSerializer().serializeToString(root), width: box[2], height: box[3] };
}

export function graphicHtml(src: string): string {
  const graphic = graphicSource(src);
  // An <img> keeps scripts disabled, including in PDF export's foreignObject.
  return `<img class="math-graphic" alt="Generated graph or diagram" draggable="false" style="display:block;width:24em;height:${24 * graphic.height / graphic.width}em" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(graphic.src)}">`;
}
