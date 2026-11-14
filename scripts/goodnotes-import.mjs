// Only the local desktop app can access matching Goodnotes PDF exports. Never expose this on hosting.
import { open, copyFile, mkdtemp, rm, stat, readdir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, basename, dirname, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';

const downloadsDir = join(homedir(), 'Downloads');
const goodnotesHistory = join(homedir(), '.local/share/nixos-fleet/webapps/goodnotes/Default/History');
const goodnotesInbox = join(homedir(), '.local/share/notesgood/goodnotes-inbox');

// Dedicated private migration exports retain their source folder, including repeated filenames.
async function inboxFiles(root, prefix = '', depth = 0) {
  if (depth > 20) return [];
  let entries;
  try { entries = await readdir(join(root, prefix), { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const path = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) files.push(...await inboxFiles(root, path, depth + 1));
    else if (entry.isFile() && /\.pdf$/i.test(entry.name)) files.push({ id: 'inbox/' + path, name: entry.name, dir: prefix || 'Goodnotes', path: join(root, path) });
  }
  return files;
}

async function openInbox(root, path) {
  const canonicalRoot = await realpath(root);
  const canonicalPath = await realpath(path);
  if (canonicalRoot !== resolve(root) || !canonicalPath.startsWith(canonicalRoot + '/') || canonicalPath !== resolve(path)) throw Object.assign(new Error('Invalid export path'), { code: 'ENOENT' });
  return open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
}

function goodnotesUrl(value) {
  try { return new URL((value || '').replace(/^blob:/, '')).hostname === 'web.goodnotes.com'; }
  catch { return false; }
}

/** Chromium locks its live History database. Read a private, stable snapshot, never the live DB. */
export async function exportNames(importDir = downloadsDir, historyFile = goodnotesHistory) {
  const { DatabaseSync } = await import('node:sqlite');
  const temp = await mkdtemp(join(tmpdir(), 'notesgood-downloads-'));
  let db;
  try {
    const before = await stat(historyFile);
    const snapshot = join(temp, 'History');
    await copyFile(historyFile, snapshot);
    for (const suffix of ['-wal', '-journal']) {
      try { await copyFile(historyFile + suffix, snapshot + suffix); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const after = await stat(historyFile);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('Download history is changing; retry on the next check');
    db = new DatabaseSync(snapshot, { readOnly: true, timeout: 300 });
    const rows = db.prepare("SELECT target_path, tab_url, tab_referrer_url FROM downloads WHERE state = 1 AND lower(target_path) LIKE '%.pdf' AND (tab_url LIKE '%web.goodnotes.com%' OR tab_referrer_url LIKE '%web.goodnotes.com%')").all();
    return [...new Set(rows.filter((row) => (goodnotesUrl(row.tab_url) || goodnotesUrl(row.tab_referrer_url)) &&
      dirname(resolve(row.target_path)) === resolve(importDir)).map((row) => basename(row.target_path)))];
  } finally { db?.close(); await rm(temp, { recursive: true, force: true }); }
}

export async function handleGoodnotesImport(req, res, { importDir = downloadsDir, historyFile = goodnotesHistory, inboxDir = goodnotesInbox } = {}) {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/goodnotes/')) return false;
  const address = req.socket.remoteAddress;
  const local = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
  let host;
  try { host = new URL('http://' + req.headers.host).hostname; } catch { /* denied below */ }
  const origin = req.headers.origin;
  if (!local || !['localhost', '127.0.0.1', '[::1]'].includes(host) || req.headers['x-notesgood-local'] !== '1' ||
      (origin && origin !== 'http://' + req.headers.host) || req.method !== 'GET') {
    res.writeHead(403).end('Local app access only'); return true;
  }
  try {
    if (url.pathname === '/api/goodnotes/exports') {
      const files = [];
      let available = true, names = [];
      try { names = await exportNames(importDir, historyFile); } catch { available = false; }
      for (const name of names) {
        let file;
        try { file = await open(join(importDir, name), constants.O_RDONLY | constants.O_NOFOLLOW); }
        catch (error) { if (['ENOENT', 'ELOOP'].includes(error.code)) continue; throw error; }
        try {
          const info = await file.stat();
          if (info.isFile()) files.push({ name, size: info.size, lastModified: Math.trunc(info.mtimeMs) });
        } finally { await file.close(); }
      }
      for (const { path, ...entry } of await inboxFiles(inboxDir)) {
        const file = await openInbox(inboxDir, path);
        try {
          const info = await file.stat();
          if (info.isFile()) files.push({ ...entry, size: info.size, lastModified: Math.trunc(info.mtimeMs) });
        } finally { await file.close(); }
      }
      if (files.some((file) => file.id)) available = true;
      files.sort((a, b) => a.name.localeCompare(b.name));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ files, available }));
    } else if (url.pathname === '/api/goodnotes/file') {
      const name = url.searchParams.get('name') || '';
      let file;
      if (name.startsWith('inbox/')) {
        const entry = (await inboxFiles(inboxDir)).find((entry) => entry.id === name);
        if (!entry) { res.writeHead(404).end(); return true; }
        file = await openInbox(inboxDir, entry.path);
      } else {
        if (name !== basename(name) || !(await exportNames(importDir, historyFile)).includes(name)) { res.writeHead(404).end(); return true; }
        file = await open(join(importDir, name), constants.O_RDONLY | constants.O_NOFOLLOW);
      }
      const info = await file.stat();
      if (!info.isFile()) { await file.close(); res.writeHead(404).end(); return true; }
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': info.size, 'Cache-Control': 'no-store' });
      const stream = file.createReadStream();
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    } else res.writeHead(404).end();
  } catch (error) {
    if (!res.headersSent) res.writeHead(error.code === 'ENOENT' ? 404 : 500).end('Could not read local export');
    else res.destroy();
  }
  return true;
}
