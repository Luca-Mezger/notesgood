// Handwriting recognition: renders a selection of strokes to an image and asks a vision model for the
// LaTeX (or plain text). Calls the selected provider directly with a key the user enters in
// Settings; nothing passes through any server of ours.
import { drawInk, unionBBox } from './render';
import type { El } from './types';

export type RecogProvider = 'claude' | 'openai';
export interface RecogConfig { provider: RecogProvider; key: string; model: string }
type ProviderConfig = Pick<RecogConfig, 'key' | 'model'>;
interface StoredConfig { provider: RecogProvider; claude: ProviderConfig; openai: ProviderConfig }
const CFG = 'margin.recog';
export const RECOG_MODELS: Record<RecogProvider, [string, string][]> = {
  claude: [
    ['claude-sonnet-5-5', 'Claude Sonnet 5.5 (recommended)'],
    ['claude-haiku-5-5', 'Claude Haiku 5.5 (faster, cheaper)'],
    ['claude-opus-5-5', 'Claude Opus 5.5 (most careful)'],
  ],
  openai: [
    ['gpt-5.4-mini', 'GPT-5.4 mini'],
    ['gpt-5.4', 'GPT-5.4'],
  ],
};

function providerConfig(provider: RecogProvider, value?: Partial<ProviderConfig> | null): ProviderConfig {
  return {
    key: typeof value?.key === 'string' ? value.key.trim() : '',
    model: RECOG_MODELS[provider].some(([id]) => id === value?.model) ? value!.model! : RECOG_MODELS[provider][0][0],
  };
}
function storedConfig(): StoredConfig {
  let value;
  try { value = JSON.parse(localStorage.getItem(CFG) ?? '{}'); } catch { /* use defaults */ }
  return {
    provider: value?.provider === 'openai' ? 'openai' : 'claude',
    // Existing settings were Claude-only. Never carry that key over to OpenAI.
    claude: providerConfig('claude', value?.claude ?? value),
    openai: providerConfig('openai', value?.openai),
  };
}
export function recogConfig(provider?: RecogProvider): RecogConfig {
  const stored = storedConfig();
  provider ??= stored.provider;
  return { provider, ...stored[provider] };
}
export function saveRecogConfig(c: RecogConfig) {
  const stored = storedConfig();
  stored.provider = c.provider;
  stored[c.provider] = providerConfig(c.provider, c);
  localStorage.setItem(CFG, JSON.stringify(stored));
}
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

const GRAPHIC_PROMPT = 'If the user asks for a graph, plot, diagram or drawing, return a complete standalone SVG instead of LaTeX. ' +
  'Use xmlns="http://www.w3.org/2000/svg" and a viewBox, with readable labels, axes and requested ranges. ' +
  'Calculate plotted curve coordinates accurately; draw curves using SVG paths or polylines. ' +
  'Use only svg, g, path, rect, circle, ellipse, line, polyline, polygon, text, tspan, defs, marker, clipPath, linearGradient, radialGradient, stop, title and desc elements. ' +
  'Use presentation attributes, plain text labels and explicit colours. No CSS/style attributes or elements, scripts, links, foreignObject, external resources, animation, HTML, Markdown or code fences. ' +
  'Otherwise return only KaTeX-compatible LaTeX, without delimiters. TikZ and pgfplots are not supported; use SVG for graphics.';

/** Asks the model for the LaTeX source (or text) of the handwriting in the PNG. */
export async function recognize(png: string, kind: 'latex' | 'text', instructions = ''): Promise<string> {
  const cfg = recogConfig();
  if (!cfg.key) throw new Error('Add your API key under Settings → Handwriting recognition first');
  instructions = instructions.trim();
  if (instructions.length > 4000) throw new Error('Keep the prompt under 4000 characters.');
  const prompt = instructions ? 'Use the selected handwriting as context and follow these user instructions:\n' + instructions + '\n\n' +
    (kind === 'latex' ? GRAPHIC_PROMPT : PROMPTS.text) : PROMPTS[kind];
  const openai = cfg.provider === 'openai';
  const res = await fetch(openai ? 'https://api.openai.com/v1/responses' : 'https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: openai ? {
      'content-type': 'application/json',
      'Authorization': `Bearer ${cfg.key}`,
    } : {
      'content-type': 'application/json',
      'x-api-key': cfg.key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(openai ? {
      model: cfg.model,
      max_output_tokens: 4096,
      store: false,
      input: [{ role: 'user', content: [
        { type: 'input_image', image_url: `data:image/png;base64,${png}`, detail: 'high' },
        { type: 'input_text', text: prompt },
      ] }],
    } : {
      model: cfg.model,
      max_tokens: instructions ? 4096 : 1200,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
        { type: 'text', text: prompt },
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
  if (data.error) throw new Error(data.error.message ?? 'Recognition failed');
  if ((openai && data.status === 'incomplete') || (!openai && data.stop_reason === 'max_tokens')) {
    throw new Error('The result was cut off. Try a simpler prompt or select a smaller area.');
  }
  const content = openai
    ? (data.output ?? []).filter((item: any) => item.type === 'message').flatMap((item: any) => item.content ?? [])
    : data.content ?? [];
  if (content.some((c: any) => c.type === 'refusal')) throw new Error('The model could not transcribe this selection');
  let out = content.filter((c: any) => c.type === (openai ? 'output_text' : 'text')).map((c: any) => c.text).join('\n').trim();
  out = out.replace(/^```(?:latex|tex|svg|xml)?\s*/i, '').replace(/\s*```$/, '').trim();
  if (kind === 'latex') out = out.replace(/^\\\[\s*|\s*\\\]$/g, '').replace(/^\$\$?\s*|\s*\$\$?$/g, '').trim();
  if (!out) throw new Error('The model returned nothing');
  return out;
}
