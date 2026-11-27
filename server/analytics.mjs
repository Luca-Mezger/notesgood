import { createHash } from 'node:crypto';
const kinds = ['writing','highlighting','erasing','editing','navigation','reading','idle','away'];
const counters = ['opens','pageViews','pageSwitches','awaySwitches','returns','focusStarts','strokes','highlights','erasures','selections','transforms','undos','redos','zooms','scrolls','characters'];
export function analyticsData(raw, id) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('Bad analytics');
  const b = {};
  for (const k of ['id','session','day','notebook','page','title','folder']) {
    if (typeof raw[k] !== 'string' || raw[k].length > (k === 'title' || k === 'folder' ? 4096 : 256)) throw Error('Bad analytics');
    b[k] = raw[k];
  }
  if (!b.id || !b.session || !b.page || !b.notebook || !/^\d{4}-\d{2}-\d{2}$/.test(b.day) || id !== 'a_' + createHash('sha256').update('opplinotes.analytics.v1:' + b.id).digest('hex')) throw Error('Bad analytics');
  for (const k of ['minute','start','end','pageNumber']) { if (!Number.isFinite(raw[k]) || raw[k] < 0) throw Error('Bad analytics'); b[k] = raw[k]; }
  if (b.start > b.end) throw Error('Bad analytics');
  for (const [group, keys] of [['ms',kinds],['counts',counters]]) {
    b[group] = {};
    for (const k of keys) { if (!Number.isFinite(raw[group]?.[k]) || raw[group][k] < 0) throw Error('Bad analytics'); b[group][k] = raw[group][k]; }
  }
  return b;
}
export function mergeAnalytics(a, b) {
  const merged = structuredClone(a && a.end > b.end ? a : b);
  if (a) {
    merged.start = Math.min(a.start,b.start); merged.end = Math.max(a.end,b.end);
    for (const k of kinds) merged.ms[k] = Math.max(a.ms[k],b.ms[k]);
    for (const k of counters) merged.counts[k] = Math.max(a.counts[k],b.counts[k]);
  }
  return merged;
}
