// Sync with a Notesgood sync server (server/sync.php or server/sync.mjs).
//
// Every local change is recorded in the `dirty` store by db.ts. A sync pushes those items, then pulls
// everything the server has seen since our last pull. Conflicts are last-write-wins per notebook / page.
// Blobs (PDFs, pictures) are uploaded once and downloaded on demand before a page that needs them is stored.
import { db } from './db';
import type { El, Notebook, Page } from './types';

export interface SyncConfig { url: string; key: string; rev: number; last: number; error?: string }
export type SyncState = 'off' | 'idle' | 'busy' | 'error';

const CFG = 'margin.sync';
let listeners = new Set<(s: SyncState, msg: string) => void>();
let state: SyncState = 'off', message = '';
let running: Promise<boolean> | null = null;

export function syncConfig(): SyncConfig {
  try { return { url: '', key: '', rev: 0, last: 0, ...JSON.parse(localStorage.getItem(CFG) ?? '{}') }; }
  catch { return { url: '', key: '', rev: 0, last: 0 }; }
}
export function saveSyncConfig(c: SyncConfig) {
  const prev = syncConfig();
  if (prev.url !== c.url) { c.rev = 0; c.last = 0; } // a different server: pull everything again
  localStorage.setItem(CFG, JSON.stringify(c));
  if (!c.url) setState('off', '');
  else if (state === 'off') setState('idle', 'Not synced yet');
}
export const syncEnabled = () => !!syncConfig().url;

export function onSync(fn: (s: SyncState, msg: string) => void): () => void {
  listeners.add(fn);
  fn(state, message);
  return () => listeners.delete(fn);
}
function setState(s: SyncState, msg: string) {
  state = s; message = msg;
  for (const fn of listeners) fn(s, msg);
}
if (syncEnabled()) { const c = syncConfig(); state = c.error ? 'error' : 'idle'; message = c.error ?? (c.last ? 'Synced ' + ago(c.last) : 'Not synced yet'); }

export function ago(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  return new Date(ts).toLocaleDateString();
}

// ---------- wire format ----------
function b64(u8: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  const bin = atob(s), u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}
const packPage = (p: Page) => ({ ...p, els: p.els.map((e) => (e.t === 's' ? { ...e, p: b64(new Uint8Array(e.p.buffer, e.p.byteOffset, e.p.byteLength)) } : e)) });
const unpackPage = (p: any): Page => ({
  ...p,
  els: (p.els as any[]).map((e): El => {
    if (e.t !== 's') return e;
    const u8 = unb64(e.p);
    return { ...e, p: new Float32Array(u8.buffer, 0, u8.byteLength >> 2) };
  }),
});
const blobsOf = (p: Page) => [...(p.bg.k === 'pdf' ? [p.bg.blob] : []), ...p.els.flatMap((e) => (e.t === 'i' ? [e.blob] : []))];

// ---------- transport ----------
async function call(cfg: SyncConfig, params: Record<string, string>, init: RequestInit = {}): Promise<Response> {
  const u = new URL(cfg.url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const res = await fetch(u, { ...init, headers: { 'X-Sync-Key': cfg.key, ...(init.headers ?? {}) } });
  if (!res.ok) {
    let msg = res.status === 401 ? 'Wrong sync key' : res.status === 404 ? 'Sync server not found at that URL' : `Server error ${res.status}`;
    try { msg = (await res.json()).error || msg; } catch { /* keep */ }
    throw new Error(msg);
  }
  return res;
}

const uploaded = new Set<string>();
async function ensureUploaded(cfg: SyncConfig, id: string) {
  if (uploaded.has(id)) return;
  const known = (await db.meta<string[]>('sync.uploaded')) ?? [];
  if (known.includes(id)) { uploaded.add(id); return; }
  const blob = await db.blob(id);
  if (!blob) return; // nothing to send; the page will show a placeholder on other devices
  await call(cfg, { a: 'blob', id }, { method: 'PUT', body: blob, headers: { 'X-Blob-Type': blob.type || 'application/octet-stream' } });
  uploaded.add(id);
  await db.putMeta('sync.uploaded', [...new Set([...known, id])]);
}
async function ensureDownloaded(cfg: SyncConfig, id: string) {
  if (await db.blob(id)) return;
  const res = await call(cfg, { a: 'blob', id });
  const blob = await res.blob();
  await db.putBlob(id, blob.type ? blob : new Blob([blob], { type: res.headers.get('Content-Type') ?? 'application/octet-stream' }));
}

// ---------- the sync itself ----------
/** Pushes local changes and (unless pushOnly) pulls remote ones. Resolves true if anything local changed. */
export function sync(pushOnly = false): Promise<boolean> {
  if (running) return running;
  running = doSync(pushOnly).finally(() => { running = null; });
  return running;
}

async function doSync(pushOnly: boolean): Promise<boolean> {
  const cfg = syncConfig();
  if (!cfg.url) return false;
  if (!navigator.onLine) { setState('idle', 'Offline; will sync when back online'); return false; }
  setState('busy', 'Syncing…');
  try {
    // ---- push
    const dirty = await db.dirty();
    let batch: any[] = [], size = 0, keys: string[] = [];
    const flushBatch = async () => {
      if (!batch.length) return;
      const res = await (await call(cfg, { a: 'push' }, { method: 'POST', body: JSON.stringify({ items: batch }), headers: { 'Content-Type': 'application/json' } })).json();
      await db.clearDirty(keys);
      batch = []; keys = []; size = 0;
      return res;
    };
    for (const key of dirty) {
      const [kind, id] = key.startsWith('d:') ? ['d', key.slice(4)] : [key[0], key.slice(2)];
      let item: any = null;
      if (kind === 'd') item = { k: 'd', id, updated: Date.now() };
      else if (kind === 'n') { const nb = await db.notebook(id); if (nb) item = { k: 'n', id, updated: nb.updated, data: nb }; }
      else if (kind === 'p') {
        const p = await db.page(id);
        if (p) {
          for (const b of blobsOf(p)) await ensureUploaded(cfg, b);
          item = { k: 'p', id, updated: p.u ?? Date.now(), data: packPage(p) };
        }
      }
      if (!item) { await db.clearDirty([key]); continue; }
      const s = JSON.stringify(item).length;
      if (batch.length && size + s > 3_000_000) await flushBatch();
      batch.push(item); keys.push(key); size += s;
    }
    await flushBatch();

    let changed = false;
    if (!pushOnly) {
      // ---- pull
      const res = await (await call(cfg, { a: 'pull', since: String(cfg.rev) })).json();
      const pending = new Set(await db.dirty()); // our unsynced edits win over what we pull
      for (const it of res.items as any[]) {
        if (it.k === 'd') {
          if (await db.notebook(it.id)) { await db.deleteNotebook(it.id, true); changed = true; }
          else if (await db.page(it.id)) { await db.deletePage(it.id, true); changed = true; }
        } else if (it.k === 'n') {
          if (pending.has('n:' + it.id)) continue;
          const local = await db.notebook(it.id);
          if (!local || local.updated < it.updated) { await db.putNotebook(it.data as Notebook, true); changed = true; }
        } else if (it.k === 'p') {
          if (pending.has('p:' + it.id)) continue;
          const local = await db.page(it.id);
          if (!local || (local.u ?? 0) < it.updated) {
            const page = unpackPage(it.data);
            for (const b of blobsOf(page)) { try { await ensureDownloaded(cfg, b); } catch (e) { console.warn('blob missing on server', b, e); } }
            await db.putPages([page], true);
            changed = true;
          }
        }
      }
      cfg.rev = res.rev;
    }
    cfg.last = Date.now();
    delete cfg.error;
    localStorage.setItem(CFG, JSON.stringify(cfg));
    setState('idle', 'Synced ' + ago(cfg.last));
    return changed;
  } catch (e: any) {
    const msg = e?.name === 'TypeError' ? 'Could not reach the sync server' : String(e?.message ?? e);
    cfg.error = msg;
    localStorage.setItem(CFG, JSON.stringify(cfg));
    setState('error', msg);
    return false;
  }
}

/** Marks every notebook and page as changed, so the next sync uploads the whole library. */
export async function markAllDirty() {
  const keys: string[] = [];
  for (const nb of await db.notebooks()) {
    keys.push('n:' + nb.id);
    for (const p of await db.pages(nb.id)) keys.push('p:' + p.id);
  }
  await db.markDirty(keys);
}
