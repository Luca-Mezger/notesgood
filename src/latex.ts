// KaTeX rendering helpers.
import katex from 'katex';

const cache = new Map<string, string>();

export function texHtml(src: string, display: boolean): string {
  const key = (display ? 'D' : 'I') + src;
  let html = cache.get(key);
  if (html == null) {
    html = katex.renderToString(src, { displayMode: display, throwOnError: false, strict: 'ignore', output: 'html' });
    if (cache.size > 500) cache.clear();
    cache.set(key, html);
  }
  return html;
}

/** Returns an error message if the source does not parse, otherwise null. */
export function texError(src: string): string | null {
  try { katex.renderToString(src, { throwOnError: true, strict: 'ignore' }); return null; }
  catch (e: any) { return String(e?.message ?? e).replace(/^KaTeX parse error: /, ''); }
}

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));

/** Plain text with `$...$` segments rendered as inline math. */
export function richHtml(text: string): string {
  let out = '';
  const re = /\$([^$\n]+)\$/g;
  let last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out += esc(text.slice(last, m.index)) + texHtml(m[1], false);
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}

export const SNIPPETS: [label: string, insert: string, caretBack?: number][] = [
  ['a/b', '\\frac{}{}', 3], ['x²', '^{}', 1], ['xₙ', '_{}', 1], ['√', '\\sqrt{}', 1],
  ['∑', '\\sum_{}^{}', 4], ['∫', '\\int_{}^{}', 4], ['lim', '\\lim_{}', 1], ['∂', '\\partial '],
  ['∞', '\\infty '], ['≤', '\\le '], ['≥', '\\ge '], ['≠', '\\ne '], ['≈', '\\approx '],
  ['→', '\\to '], ['⇒', '\\Rightarrow '], ['·', '\\cdot '], ['×', '\\times '], ['∈', '\\in '],
  ['ℝ', '\\mathbb{R}'], ['α', '\\alpha '], ['β', '\\beta '], ['γ', '\\gamma '], ['δ', '\\delta '],
  ['ε', '\\varepsilon '], ['θ', '\\theta '], ['λ', '\\lambda '], ['μ', '\\mu '], ['π', '\\pi '],
  ['σ', '\\sigma '], ['φ', '\\varphi '], ['ω', '\\omega '], ['Δ', '\\Delta '], ['Ω', '\\Omega '],
  ['vec', '\\vec{}', 1], ['hat', '\\hat{}', 1], ['( )', '\\left(  \\right)', 8],
  ['matrix', '\\begin{pmatrix}  &  \\\\  &  \\end{pmatrix}', 25], ['aligned', '\\begin{aligned}  &=  \\\\  &= \\end{aligned}', 26],
];
