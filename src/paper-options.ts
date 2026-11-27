import { paperMetrics, type Ruling, type Tpl } from './types';
import { drawPaper } from './render';
import { h } from './ui';

/** Shared by creation, PDF import and the editor. Values are stored in page points. */
export function paperOptions(tpl: () => Tpl, value: () => Ruling | undefined, change: (ruling: Ruling) => void) {
  const mm = 72 / 25.4;
  const spacing = h('input', { class: 'field', type: 'number', min: 1.1, max: 30, step: 0.1, 'aria-label': 'Pattern spacing (mm)' });
  const weight = h('input', { class: 'field', type: 'number', min: 0.04, max: 2, step: 0.02, 'aria-label': 'Line or dot size (mm)' });
  const sizeLabel = h('span', null);
  const preview = h('canvas', { class: 'ruling-preview', width: 360, height: 100, 'aria-label': 'Paper pattern preview' });
  const root = h('div', { class: 'paper-options' }, h('div', { class: 'row' }, h('label', null, 'Spacing (mm)', spacing), h('label', null, sizeLabel, weight)), preview);
  const refresh = () => {
    root.hidden = tpl() === 'blank';
    const m = paperMetrics(tpl(), value());
    spacing.value = String(Math.round(m.spacing / mm * 100) / 100);
    weight.value = String(Math.round(m.weight / mm * 100) / 100);
    sizeLabel.textContent = tpl() === 'dots' ? 'Dot size (mm)' : 'Line thickness (mm)';
    drawPaper(preview.getContext('2d')!, 0, 0, 360, 100, tpl(), '#fff', value());
  };
  for (const input of [spacing, weight]) input.addEventListener('change', () => {
    if (!input.value || !Number.isFinite(input.valueAsNumber)) { refresh(); return; }
    const m = paperMetrics(tpl(), value());
    change(paperMetrics(tpl(), { ...m, [input === spacing ? 'spacing' : 'weight']: input.valueAsNumber * mm }));
    refresh();
  });
  refresh();
  return { root, refresh };
}
