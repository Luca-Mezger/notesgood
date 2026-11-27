import { ACTIVITY_KINDS, COUNTERS, type ActivityBucket } from './activity';
/** Shared validation keeps malformed sync payloads out of local analytics. */
export function activityBucket(value: unknown): ActivityBucket | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const b = value as ActivityBucket;
  for (const key of ['id', 'session', 'day', 'notebook', 'page', 'title', 'folder'] as const) {
    if (typeof b[key] !== 'string' || b[key].length > (key === 'title' || key === 'folder' ? 4096 : 256)) return null;
  }
  if (!b.id || !b.session || !b.page || !b.notebook || !/^\d{4}-\d{2}-\d{2}$/.test(b.day)) return null;
  for (const key of ['minute', 'start', 'end', 'pageNumber'] as const) if (!Number.isFinite(b[key]) || b[key] < 0) return null;
  if (b.start > b.end || !b.ms || !b.counts) return null;
  for (const key of ACTIVITY_KINDS) if (!Number.isFinite(b.ms[key]) || b.ms[key] < 0) return null;
  for (const key of COUNTERS) if (!Number.isFinite(b.counts[key]) || b.counts[key] < 0) return null;
  // Explicit fields: no note contents or unexpected properties can travel in this record.
  return { id: b.id, session: b.session, day: b.day, notebook: b.notebook, page: b.page, title: b.title, folder: b.folder, minute: b.minute, start: b.start, end: b.end, pageNumber: b.pageNumber,
    ms: Object.fromEntries(ACTIVITY_KINDS.map(k => [k, b.ms[k]])) as ActivityBucket['ms'], counts: Object.fromEntries(COUNTERS.map(k => [k, b.counts[k]])) as ActivityBucket['counts'] };
}
export async function activityWireId(id: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('opplinotes.analytics.v1:' + id));
  return 'a_' + [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('');
}
