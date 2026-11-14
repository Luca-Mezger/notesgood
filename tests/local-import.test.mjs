import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { exportNames, handleGoodnotesImport } from '../scripts/goodnotes-import.mjs';

test('automatic pickup uses actual Goodnotes downloads and blocks unrelated files and other origins', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'notesgood-test-'));
  const importDir = join(temp, 'Downloads'), historyFile = join(temp, 'History');
  await mkdir(importDir);
  const db = new DatabaseSync(historyFile);
  db.exec('CREATE TABLE downloads (target_path TEXT, tab_url TEXT, tab_referrer_url TEXT, state INTEGER)');
  const insert = db.prepare('INSERT INTO downloads VALUES (?, ?, ?, ?)');
  for (const [name, url, state] of [
    ['Lecture.pdf', 'https://web.goodnotes.com/doc/123', 1],
    ['Unrelated.pdf', 'https://example.com/', 1],
    ['Source - Goodnotes - Kariert.pdf', 'https://example.com/', 1],
    ['Partial.pdf', 'https://web.goodnotes.com/', 0],
    ['Spoof.pdf', 'https://web.goodnotes.com.evil.example/', 1],
  ]) { await writeFile(join(importDir, name), '%PDF-' + name); insert.run(join(importDir, name), url, '', state); }
  await writeFile(join(temp, 'Outside.pdf'), '%PDF-outside');
  await symlink(join(temp, 'Outside.pdf'), join(importDir, 'Link.pdf'));
  insert.run(join(importDir, 'Link.pdf'), 'https://web.goodnotes.com/', '', 1);
  insert.run(join(temp, 'Outside.pdf'), 'https://web.goodnotes.com/', '', 1);
  db.close();
  const server = createServer((req, res) => { handleGoodnotesImport(req, res, { importDir, historyFile }).then((handled) => { if (!handled) res.writeHead(404).end(); }); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const headers = { 'X-Notesgood-Local': '1' };
  try {
    const names = await exportNames(importDir, historyFile);
    assert(names.includes('Lecture.pdf')); assert(!names.includes('Unrelated.pdf')); assert(!names.includes('Spoof.pdf')); assert(!names.includes('Outside.pdf'));
    assert.equal((await fetch(base + '/api/goodnotes/exports')).status, 403);
    assert.equal((await fetch(base + '/api/goodnotes/exports', { headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
    const spoofedHost = await new Promise((resolve, reject) => {
      const req = request(base + '/api/goodnotes/exports', { headers: { ...headers, Host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(spoofedHost, 403);
    const response = await fetch(base + '/api/goodnotes/exports', { headers });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).files.map((f) => f.name), ['Lecture.pdf']);
    assert.equal(await (await fetch(base + '/api/goodnotes/file?name=Lecture.pdf', { headers })).text(), '%PDF-Lecture.pdf');
    assert.equal((await fetch(base + '/api/goodnotes/file?name=Unrelated.pdf', { headers })).status, 404);
    assert.equal((await fetch(base + '/api/goodnotes/file?name=..%2FOutside.pdf', { headers })).status, 404);
    assert.notEqual((await fetch(base + '/api/goodnotes/file?name=Link.pdf', { headers })).status, 200);
  } finally { await new Promise((resolve) => server.close(resolve)); await rm(temp, { recursive: true, force: true }); }
});
