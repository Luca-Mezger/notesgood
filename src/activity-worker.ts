// Runs entirely off the editor's main thread. Never receives pointer coordinates or note contents.
import { ActivityClock, type ActivityContext, type ActiveKind, type Counter } from './activity';
import { writeActivity } from './activity-store';
let clock: ActivityClock | null = null;
let pending = new Map<string, ReturnType<ActivityClock['drain']>[number]>();
let chain = Promise.resolve(), timer: ReturnType<typeof setInterval> | undefined;
let lastStamp = 0, closing = false;
let wall = Date.now(), mono = performance.now();
const now = () => Math.max(lastStamp, wall + performance.now() - mono - 500);
function save() {
  if (!clock) return chain;
  for (const row of clock.drain(now())) pending.set(row.id, row);
  const rows = [...pending.values()];
  chain = chain.then(async () => {
    try {
      await writeActivity(rows);
      for (const row of rows) if (pending.get(row.id) === row) pending.delete(row.id);
    } catch { postMessage({ type: 'storage-error' }); }
  });
  return chain;
}
type Event = { type: 'activity'; kind: ActiveKind; at: number; lease?: number } | { type: 'release'; at: number } | { type: 'count'; key: Counter; amount?: number; at: number } | { type: 'context'; context: ActivityContext; at: number } | { type: 'foreground'; value: boolean; at: number };
self.onmessage = ({ data }) => {
  if (data.type === 'start') {
    wall = data.at; mono = performance.now(); lastStamp = data.at;
    clock = new ActivityClock(data.session, data.context, data.at, data.idleMs, data.foreground);
    timer = setInterval(() => { if (!closing) void save(); }, 1000);
    postMessage({ type: 'ready' }); return;
  }
  if (!clock || closing) return;
  if (data.type === 'events') {
    for (const e of data.events as Event[]) {
      lastStamp = Math.max(lastStamp, e.at);
      if (e.type === 'activity') clock.activity(e.kind, e.at, e.lease);
      else if (e.type === 'release') clock.release(e.at);
      else if (e.type === 'count') clock.count(e.key, e.at, e.amount);
      else if (e.type === 'context') clock.setContext(e.context, e.at);
      else if (e.type === 'foreground') clock.setForeground(e.value, e.at);
    }
  } else if (data.type === 'close') {
    closing = true; clearInterval(timer); lastStamp = Math.max(lastStamp, data.at);
    clock.stop(data.at); void save().then(() => postMessage({ type: 'closed' }));
  } else if (data.type === 'flush') void save();
};
