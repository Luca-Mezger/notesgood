import type { ActivityBucket, Counter } from './activity';

const PENDING = 'opplinotes.analytics.pending.';
let opening: Promise<IDBDatabase> | undefined;
function open() {
  return opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open('opplinotes-analytics', 2);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('buckets')) d.createObjectStore('buckets', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('dirty')) {
        const dirty = d.createObjectStore('dirty');
        // Existing local-only history is uploaded once after upgrading.
        const cursor = r.transaction!.objectStore('buckets').openKeyCursor();
        cursor.onsuccess = () => { const c = cursor.result; if (c) { dirty.put(crypto.randomUUID(), c.key); c.continue(); } };
      }
    };
    r.onsuccess = () => { const d = r.result; d.onversionchange = () => { d.close(); opening = undefined; }; resolve(d); };
    r.onerror = () => { opening = undefined; reject(r.error); };
  });
}
export async function writeActivity(rows: ActivityBucket[], local = true) {
  if (!rows.length) return;
  const d = await open();
  await new Promise<void>((resolve, reject) => {
    const t = d.transaction(['buckets', 'dirty'], 'readwrite');
    const store = t.objectStore('buckets');
    for (const row of rows) {
      const r = store.get(row.id);
      r.onsuccess = () => {
        const old: ActivityBucket | undefined = r.result;
        if (!old) { store.put(row); if (local) t.objectStore('dirty').put(crypto.randomUUID(), row.id); return; }
        // Two tabs may recover a journal while its owner finishes a newer save.
        // Each record is cumulative: maxima make replay/order harmless.
        const merged = structuredClone(row.end >= old.end ? row : old);
        merged.start = Math.min(row.start, old.start); merged.end = Math.max(row.end, old.end);
        for (const k of Object.keys(row.ms) as (keyof ActivityBucket['ms'])[]) merged.ms[k] = Math.max(row.ms[k], old.ms[k]);
        for (const k of Object.keys(row.counts) as Counter[]) merged.counts[k] = Math.max(row.counts[k], old.counts[k]);
        if (JSON.stringify(merged) !== JSON.stringify(old)) {
          store.put(merged);
          if (local) t.objectStore('dirty').put(crypto.randomUUID(), row.id);
        }
      };
    }
    t.oncomplete = () => resolve(); t.onerror = t.onabort = () => reject(t.error);
  });
}
export async function activityRows(): Promise<ActivityBucket[]> {
  // Recover cumulative checkpoints left by a closed tab. Replaying is idempotent.
  for (const k of Object.keys(localStorage).filter(k => k.startsWith(PENDING))) {
    const raw = localStorage.getItem(k);
    try {
      const rows = JSON.parse(raw || '[]');
      if (Array.isArray(rows) && rows.every(r => r && typeof r.id === 'string' && r.ms && r.counts)) await writeActivity(rows);
      if (localStorage.getItem(k) === raw) localStorage.removeItem(k);
    } catch { /* Keep a failed checkpoint for the next read. */ }
  }
  const d = await open();
  return new Promise((resolve, reject) => {
    const r = d.transaction('buckets').objectStore('buckets').getAll();
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
}
export function idleSeconds() { const n = Number(localStorage.getItem('opplinotes.analytics.idle')); return [15, 30, 60, 120].includes(n) ? n : 30; }
export function trackingEnabled() { return localStorage.getItem('opplinotes.analytics.enabled') !== 'off'; }


export async function pendingActivity(): Promise<{ row: ActivityBucket; token: string }[]> {
  const d = await open();
  return new Promise((resolve, reject) => {
    const rows: { row: ActivityBucket; token: string }[] = [];
    const t = d.transaction(['buckets', 'dirty']);
    const cursor = t.objectStore('dirty').openCursor();
    cursor.onsuccess = () => {
      const c = cursor.result; if (!c) return;
      const token = c.value as string, get = t.objectStore('buckets').get(c.key);
      get.onsuccess = () => { if (get.result) rows.push({ row: get.result, token }); };
      c.continue();
    };
    t.oncomplete = () => resolve(rows); t.onerror = t.onabort = () => reject(t.error);
  });
}
export async function acknowledgeActivity(sent: { row: ActivityBucket; token: string }[]) {
  const d = await open();
  await new Promise<void>((resolve, reject) => {
    const t = d.transaction('dirty', 'readwrite'), store = t.objectStore('dirty');
    for (const { row, token } of sent) {
      const r = store.get(row.id);
      r.onsuccess = () => { if (r.result === token) store.delete(row.id); };
    }
    t.oncomplete = () => resolve(); t.onerror = t.onabort = () => reject(t.error);
  });
}
