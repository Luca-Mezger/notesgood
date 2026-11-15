// IndexedDB storage. Everything stays on the device.
import type { Notebook, Page } from './types';

let dbp: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  return (dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('margin', 2);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      if (ev.oldVersion < 1) {
        db.createObjectStore('notebooks', { keyPath: 'id' });
        db.createObjectStore('pages', { keyPath: 'id' }).createIndex('nb', 'nb');
        db.createObjectStore('blobs');
        db.createObjectStore('meta');
      }
      // Keys of things changed since the last sync: 'n:<id>', 'p:<id>', 'd:n:<id>', 'd:p:<id>'.
      if (ev.oldVersion < 2) db.createObjectStore('dirty');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(stores: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => T | Promise<T>): Promise<T> {
  const db = await open();
  const t = db.transaction(stores, mode);
  const done = new Promise<void>((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = t.onabort = () => reject(t.error);
  });
  const out = await fn(t);
  await done;
  return out;
}

/** Writes done by the sync itself pass `silent = true` so they are not pushed back again. */
export const db = {
  notebooks: () => tx(['notebooks'], 'readonly', (t) => wrap<Notebook[]>(t.objectStore('notebooks').getAll())),
  notebook: (id: string) => tx(['notebooks'], 'readonly', (t) => wrap<Notebook | undefined>(t.objectStore('notebooks').get(id))),
  putNotebook: (nb: Notebook, silent = false) => tx(['notebooks', 'dirty'], 'readwrite', (t) => {
    t.objectStore('notebooks').put(nb);
    if (!silent) { t.objectStore('dirty').put(Date.now(), 'n:' + nb.id); t.objectStore('dirty').delete('d:n:' + nb.id); }
  }),

  /** Folder changes and their notebook sync markers commit together; pages/blobs stay untouched. */
  putFolders: (folders: string[], changed: Notebook[] = []) => tx(['notebooks', 'dirty', 'meta'], 'readwrite', (t) => {
    t.objectStore('meta').put(folders, 'folders');
    for (const nb of changed) {
      t.objectStore('notebooks').put(nb);
      t.objectStore('dirty').put(Date.now(), 'n:' + nb.id);
      t.objectStore('dirty').delete('d:n:' + nb.id);
    }
  }),

  pages: (nb: string) => tx(['pages'], 'readonly', (t) => wrap<Page[]>(t.objectStore('pages').index('nb').getAll(nb))),
  page: (id: string) => tx(['pages'], 'readonly', (t) => wrap<Page | undefined>(t.objectStore('pages').get(id))),
  putPages: (pages: Page[], silent = false) => tx(['pages', 'dirty'], 'readwrite', (t) => {
    const now = Date.now();
    for (const p of pages) {
      if (!silent) { p.u = now; t.objectStore('dirty').put(now, 'p:' + p.id); t.objectStore('dirty').delete('d:p:' + p.id); }
      t.objectStore('pages').put(p);
    }
  }),
  deletePage: (id: string, silent = false) => tx(['pages', 'dirty'], 'readwrite', (t) => {
    t.objectStore('pages').delete(id);
    if (!silent) { t.objectStore('dirty').delete('p:' + id); t.objectStore('dirty').put(Date.now(), 'd:p:' + id); }
  }),

  blob: (id: string) => tx(['blobs'], 'readonly', (t) => wrap<Blob | undefined>(t.objectStore('blobs').get(id))),
  putBlob: (id: string, b: Blob) => tx(['blobs'], 'readwrite', (t) => { t.objectStore('blobs').put(b, id); }),

  /** Removes a notebook, its pages and any PDF blobs only it used. */
  async deleteNotebook(id: string, silent = false) {
    const pages = await db.pages(id);
    const blobs = new Set<string>();
    for (const p of pages) {
      if (p.bg.k === 'pdf') blobs.add(p.bg.blob);
      for (const e of p.els) if (e.t === 'i') blobs.add(e.blob);
    }
    await tx(['notebooks', 'pages', 'blobs', 'dirty'], 'readwrite', (t) => {
      t.objectStore('notebooks').delete(id);
      for (const p of pages) t.objectStore('pages').delete(p.id);
      for (const b of blobs) t.objectStore('blobs').delete(b);
      const d = t.objectStore('dirty');
      d.delete('n:' + id);
      for (const p of pages) d.delete('p:' + p.id);
      if (!silent) { d.put(Date.now(), 'd:n:' + id); for (const p of pages) d.put(Date.now(), 'd:p:' + p.id); }
    });
  },

  dirty: () => tx(['dirty'], 'readonly', (t) => wrap<string[]>(t.objectStore('dirty').getAllKeys() as IDBRequest<string[]>)),
  markDirty: (keys: string[]) => tx(['dirty'], 'readwrite', (t) => { for (const k of keys) t.objectStore('dirty').put(Date.now(), k); }),
  clearDirty: (keys: string[]) => tx(['dirty'], 'readwrite', (t) => { for (const k of keys) t.objectStore('dirty').delete(k); }),

  meta: <T>(key: string) => tx(['meta'], 'readonly', (t) => wrap<T | undefined>(t.objectStore('meta').get(key))),
  putMeta: (key: string, v: unknown) => tx(['meta'], 'readwrite', (t) => { t.objectStore('meta').put(v, key); }),
};

/** Ask the browser not to evict our data under storage pressure. */
export function requestPersistence() {
  navigator.storage?.persist?.().catch(() => {});
}
