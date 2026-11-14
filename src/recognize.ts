// Handwriting recognition: renders a selection of strokes to an image and asks a vision model for the
// LaTeX (or plain text). Uses the Claude API directly from the browser with a key the user enters in
// Settings; nothing passes through any server of ours.
import { drawInk, unionBBox } from './render';
import type { El } from './types';

export interface RecogConfig { key: string; model: string }
const CFG = 'margin.recog';
export const RECOG_MODELS: [string, string][] = [
  ['claude-sonnet-5-5', 'Claude Sonnet 5.5 (recommended)'],
  ['claude-haiku-5-5', 'Claude Haiku 5.5 (faster, cheaper)'],
  ['claude-opus-5-5', 'Claude Opus 5.5 (most careful)'],
];

export function recogConfig(): RecogConfig {
  try { return { key: '', model: RECOG_MODELS[0][0], ...JSON.parse(localStorage.getItem(CFG) ?? '{}') }; }
  catch { return { key: '', model: RECOG_MODELS[0][0] }; }
}
export function saveRecogConfig(c: RecogConfig) { localStorage.setItem(CFG, JSON.stringify(c)); }
export const recogReady = () => !!recogConfig().key;

/** Renders ink elements onto white at a legible size and returns a PNG as base64. */
export function inkToPng(els: El[]): { png: string; w: number; h: number } {
  const bb = unionBBox(els.filter((e) => e.t === 's' || e.t === 'h'));
  if (!bb) throw new Error('Select some handwriting first');
  const pad = 12, w = bb[2] - bb[0] + pad * 2, h = bb[3] - bb[1] + pad * 2;
  const k = Math.min(4, Math.max(1.5, 1100 / Math.max(w, h)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * k); canvas.height = Math.round(h * k);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(k, 0, 0, k, (pad - bb[0]) * k, (pad - bb[1]) * k);
  // Draw everything in near-black so colour choices do not confuse the model.
  drawInk(ctx, els.map((e) => (e.t === 's' || e.t === 'h' ? { ...e, c: '#111' } : e)));
  return { png: canvas.toDataURL('image/png').split(',')[1], w, h };
}

const PROMPTS = {
  latex: 'The image shows handwritten mathematics. Transcribe it as LaTeX for KaTeX display mode. ' +
    'Reply with the LaTeX source only: no $ delimiters, no \\[ \\], no code fences, no explanation. ' +
    'Use \\begin{aligned} ... \\end{aligned} for several lines. If part is unreadable, make your best guess.',
  text: 'The image shows handwriting. Transcribe it as plain text, keeping line breaks. ' +
    'Reply with the transcription only, no quotes, no explanation. Write any mathematics inline as $...$ LaTeX.',
};

/** Asks the model for the LaTeX source (or text) of the handwriting in the PNG. */
export async function recognize(png: string, kind: 'latex' | 'text'): Promise<string> {
  const cfg = recogConfig();
  if (!cfg.key) throw new Error('Add your API key under Settings → Handwriting recognition first');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': cfg.key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 1200,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
        { type: 'text', text: PROMPTS[kind] },
      ] }],
    }),
  });
  if (!res.ok) {
    let msg = `Recognition failed (${res.status})`;
    try { msg = (await res.json()).error?.message ?? msg; } catch { /* keep */ }
    if (res.status === 401) msg = 'The API key was rejected';
    throw new Error(msg);
  }
  const data = await res.json();
  let out = (data.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n').trim();
  out = out.replace(/^```(?:latex|tex)?\s*/i, '').replace(/\s*```$/, '').trim();
  if (kind === 'latex') out = out.replace(/^\\\[\s*|\s*\\\]$/g, '').replace(/^\$\$?\s*|\s*\$\$?$/g, '').trim();
  if (!out) throw new Error('The model returned nothing');
  return out;
}
