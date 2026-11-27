/** Content-free, local study telemetry. Time categories are mutually exclusive. */
export const ACTIVITY_KINDS = ['writing', 'highlighting', 'erasing', 'editing', 'navigation', 'reading', 'idle', 'away'] as const;
export type ActivityKind = typeof ACTIVITY_KINDS[number];
export type ActiveKind = Exclude<ActivityKind, 'reading' | 'idle' | 'away'>;
export const COUNTERS = ['opens', 'pageViews', 'pageSwitches', 'awaySwitches', 'returns', 'focusStarts', 'strokes', 'highlights', 'erasures', 'selections', 'transforms', 'undos', 'redos', 'zooms', 'scrolls', 'characters'] as const;
export type Counter = typeof COUNTERS[number];
export interface ActivityContext { notebook: string; title: string; folder: string; page: string; pageNumber: number }
export interface ActivityBucket extends ActivityContext {
  id: string; session: string; day: string; minute: number; start: number; end: number;
  ms: Record<ActivityKind, number>; counts: Record<Counter, number>;
}
export const emptyTimes = () => Object.fromEntries(ACTIVITY_KINDS.map(k => [k, 0])) as Record<ActivityKind, number>;
export const emptyCounts = () => Object.fromEntries(COUNTERS.map(k => [k, 0])) as Record<Counter, number>;
export function dayKey(t: number) { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
export function activeMs(b: Pick<ActivityBucket, 'ms'>) { return ACTIVITY_KINDS.filter(k => k !== 'idle' && k !== 'away').reduce((n, k) => n + b.ms[k], 0); }

/** Pure clock: callers supply monotonic wall timestamps, so tests need no timers or DOM. */
export class ActivityClock {
  private cursor: number;
  private lastInput: number;
  private lease = 0;
  private kind: ActiveKind = 'editing';
  private foreground = true;
  private focused = false;
  private stopped = false;
  private buckets = new Map<string, ActivityBucket>();
  private dirty = new Set<string>();
  constructor(public readonly session: string, private context: ActivityContext, now: number, public idleMs = 30_000, foreground = true) {
    this.cursor = this.lastInput = now;
    this.count('opens', now); this.count('pageViews', now);
    this.foreground = foreground;
    if (foreground) this.count('focusStarts', now);
    this.focused = foreground;
  }
  private bucket(t: number) {
    const minute = Math.floor(t / 60_000) * 60_000;
    const id = `${this.session}:${minute}:${this.context.page}`;
    let b = this.buckets.get(id);
    if (!b) {
      b = { ...this.context, id, session: this.session, day: dayKey(t), minute, start: t, end: t, ms: emptyTimes(), counts: emptyCounts() };
      this.buckets.set(id, b);
    }
    this.dirty.add(id);
    return b;
  }
  tick(now: number) {
    if (this.stopped || !Number.isFinite(now) || now <= this.cursor) return;
    // A suspended process cannot demonstrate activity. Never backfill a long sleep as writing.
    const suspended = now - this.cursor > 10_000;
    while (this.cursor < now) {
      let k: ActivityKind = !this.foreground ? 'away' : suspended || this.cursor >= this.lastInput + this.idleMs ? 'idle' : this.cursor < this.lease ? this.kind : 'reading';
      let end = Math.min(now, (Math.floor(this.cursor / 60_000) + 1) * 60_000);
      if (!suspended && this.foreground) {
        if (this.cursor < this.lastInput + this.idleMs) end = Math.min(end, this.lastInput + this.idleMs);
        if (this.cursor < this.lease) end = Math.min(end, this.lease);
      }
      const b = this.bucket(this.cursor); b.ms[k] += end - this.cursor; b.end = end;
      if (k === 'idle' || k === 'away') this.focused = false;
      this.cursor = end;
    }
  }
  activity(kind: ActiveKind, now: number, lease = 500) {
    this.tick(now);
    if (this.stopped || !this.foreground) return;
    if (!this.focused) { this.count('focusStarts', now); this.focused = true; }
    this.kind = kind; this.lastInput = now; this.lease = now + Math.min(2000, Math.max(0, lease));
  }
  release(now: number) { this.tick(now); this.lease = now; }
  count(key: Counter, now: number, amount = 1) {
    if (this.stopped || !this.foreground || !Number.isFinite(amount) || amount <= 0) return;
    this.tick(now); const b = this.bucket(now); b.counts[key] += amount; b.end = Math.max(b.end, now);
  }
  setContext(context: ActivityContext, now: number) {
    if (this.stopped) return;
    this.tick(now);
    const changed = context.page !== this.context.page;
    this.context = { ...context };
    if (changed) { this.count('pageSwitches', now); this.count('pageViews', now); }
  }
  setForeground(value: boolean, now: number) {
    this.tick(now);
    if (this.stopped || this.foreground === value) return;
    if (!value) this.count('awaySwitches', now);
    this.foreground = value; this.lease = now; this.focused = false;
    if (value) { this.count('returns', now); this.lastInput = now; }
  }
  drain(now: number) {
    this.tick(now);
    const rows = [...this.dirty].map(id => structuredClone(this.buckets.get(id)!));
    this.dirty.clear();
    // Only the current minute is mutable; older buckets can leave memory after checkpointing.
    for (const [id, b] of this.buckets) if (b.minute < Math.floor(this.cursor / 60_000) * 60_000) this.buckets.delete(id);
    return rows;
  }
  stop(now: number) { this.tick(now); this.stopped = true; }
}
