// Notesgood sync server for a VPS or any machine with Node (no dependencies). Same API as sync.php,
// and it also serves the built app from ../dist, so one process runs everything.
//
//   SYNC_KEY=<secret> node server/sync.mjs            (or put the secret in server/sync-key.txt)
//   PORT=8787 DATA_DIR=./sync-data                    optional
//
// Put it behind HTTPS (Caddy, nginx, or Hostinger's proxy) before using it from another device.
import { analyticsData, mergeAnalytics } from './analytics.mjs';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, createWriteStream, unlinkSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'dist');
const dataDir = process.env.DATA_DIR || join(here, 'sync-data');
const port = Number(process.env.PORT || 8787);
const keyFile = join(here, 'sync-key.txt');
const key = (process.env.SYNC_KEY || (existsSync(keyFile) ? readFileSync(keyFile, 'utf8') : '')).trim();
if (!key) { console.error('Set SYNC_KEY or create server/sync-key.txt'); process.exit(1); }
for (const d of [dataDir, join(dataDir, 'items'), join(dataDir, 'blobs')]) mkdirSync(d, { recursive: true });

const indexFile = join(dataDir, 'index.json');
let index = existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, 'utf8')) : { rev: 0, items: {} };
const saveIndex = () => { writeFileSync(indexFile + '.tmp', JSON.stringify(index)); renameSync(indexFile + '.tmp', indexFile); };
const safeId = (id) => /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : null;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };

const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve, reject) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => resolve(Buffer.concat(c))); req.on('error', reject); });

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Sync-Key, X-Blob-Type');
  if (req.method === 'OPTIONS') return res.writeHead(204).end();

  if (url.pathname === '/sync') {
    if (req.headers['x-sync-key'] !== key) return json(res, 401, { error: 'Wrong sync key' });
    const a = url.searchParams.get('a');
    try {
      if (a === 'pull') {
        const since = Number(url.searchParams.get('since') || 0);
        const items = [];
        for (const [id, m] of Object.entries(index.items)) {
          if (m.rev <= since) continue;
          const it = { k: m.k, id, updated: m.updated, rev: m.rev };
          if (m.k !== 'd') { try { it.data = JSON.parse(readFileSync(join(dataDir, 'items', id + '.json'), 'utf8')); } catch { continue; } }
          items.push(it);
        }
        items.sort((x, y) => x.rev - y.rev);
        return json(res, 200, { rev: index.rev, items });
      }
      if (a === 'push') {
        const body = JSON.parse((await readBody(req)).toString('utf8'));
        const skipped = [];
        for (const it of body.items ?? []) {
          const id = safeId(String(it.id ?? ''));
          if (!id || !['n', 'p', 'd', 'a'].includes(it.k)) return json(res, 400, { error: 'Bad item' });
          const cur = index.items[id];
          let data = it.data;
          if (it.k === 'a') {
            try {
              data = analyticsData(data, id);
              if (cur && cur.k !== 'a') return json(res, 400, { error: 'Analytics id collision' });
              const old = cur ? analyticsData(JSON.parse(readFileSync(join(dataDir, 'items', id + '.json'), 'utf8')), id) : null;
              data = mergeAnalytics(old, data);
              it.updated = Math.max(Number(it.updated), cur?.updated ?? 0, data.end);
            } catch { return json(res, 400, { error: 'Bad analytics' }); }
          }
          if (it.k !== 'a' && cur && cur.updated > Number(it.updated)) { skipped.push(id); continue; }
          index.rev++;
          index.items[id] = { k: it.k, updated: Number(it.updated), rev: index.rev };
          const f = join(dataDir, 'items', id + '.json');
          if (it.k === 'd') { try { unlinkSync(f); } catch {} } else writeFileSync(f, JSON.stringify(data ?? null));
        }
        saveIndex();
        return json(res, 200, { rev: index.rev, skipped });
      }
      if (a === 'blob') {
        const id = safeId(url.searchParams.get('id') || '');
        if (!id) return json(res, 400, { error: 'Bad id' });
        const path = join(dataDir, 'blobs', id);
        if (req.method === 'GET' || req.method === 'HEAD') {
          if (!existsSync(path)) return json(res, 404, { error: 'No such blob' });
          const type = existsSync(path + '.type') ? readFileSync(path + '.type', 'utf8') : 'application/octet-stream';
          res.writeHead(200, { 'Content-Type': type, 'Content-Length': statSync(path).size });
          return req.method === 'HEAD' ? res.end() : createReadStream(path).pipe(res);
        }
        const out = createWriteStream(path + '.tmp');
        await new Promise((ok, bad) => req.pipe(out).on('finish', ok).on('error', bad));
        renameSync(path + '.tmp', path);
        writeFileSync(path + '.type', String(req.headers['x-blob-type'] || 'application/octet-stream').replace(/[^a-z0-9/.+-]/gi, ''));
        return json(res, 200, { ok: true, size: statSync(path).size });
      }
    } catch (e) { console.error(e); return json(res, 500, { error: String(e.message || e) }); }
    return json(res, 404, { error: 'Unknown action' });
  }

  // Static app
  try {
    let p = normalize(decodeURIComponent(url.pathname));
    if (p.includes('..')) throw new Error();
    let file = join(dist, p);
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    createReadStream(file).on('error', () => res.end()).pipe(res);
  } catch { res.writeHead(404).end('Not found'); }
}).listen(port, '0.0.0.0', () => console.log(`Notesgood + sync listening on http://localhost:${port}`));
