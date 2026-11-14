import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { deflateRawSync } from 'node:zlib';

const { outputFiles } = await build({ entryPoints: ['src/import.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { collectPdfSources, importFolders, importTitle, pdfHash } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));

function zip(entries) {
  const locals = [], central = [];
  let offset = 0;
  for (const [name, contents] of entries) {
    const filename = Buffer.from(name), data = Buffer.from(contents), compressed = deflateRawSync(data);
    let crc = -1;
    for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; }
    crc = (crc ^ -1) >>> 0;
    const local = Buffer.alloc(30), cd = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
    cd.writeUInt32LE(0x02014b50); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(compressed.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(filename.length, 28); cd.writeUInt32LE(offset, 42);
    locals.push(local, filename, compressed); central.push(cd, filename);
    offset += local.length + filename.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test('PDF folders remain meaningful, including a single folder or a single document', () => {
  assert.deepEqual(importFolders([{ dir: 'Export/Math' }, { dir: 'Export/Physics' }]), ['Math', 'Physics']);
  assert.deepEqual(importFolders([{ dir: 'Math' }, { dir: 'Math' }]), ['Math', 'Math']);
  assert.deepEqual(importFolders([{ dir: 'Math/Week 1' }]), ['Math / Week 1']);
  assert.deepEqual(importFolders([{ dir: 'Math/Week 1', sourceId: 'inbox/a' }, { dir: 'Math/Week 2', sourceId: 'inbox/b' }]), ['Math / Week 1', 'Math / Week 2']);
});

test('Goodnotes export suffixes are removed without changing ordinary titles', () => {
  assert.equal(importTitle('Lecture - Goodnotes - Gepunktet.pdf'), 'Lecture');
  assert.equal(importTitle('Goodnotes tips.pdf'), 'Goodnotes tips');
  assert.equal(importTitle('LECTURE.PDF'), 'LECTURE');
});

test('content fingerprint detects identical PDFs even after renaming', async () => {
  const first = await pdfHash(new TextEncoder().encode('same PDF').buffer);
  assert.equal(first, await pdfHash(new TextEncoder().encode('same PDF').buffer));
  assert.notEqual(first, await pdfHash(new TextEncoder().encode('changed PDF').buffer));
});

test('nested PDF ZIP exports keep folders and ignore macOS metadata', async () => {
  const nested = zip([['Week 1/Notes.PDF', '%PDF-demo']]);
  const data = zip([['Math.zip', nested], ['Physics/Lecture.pdf', '%PDF-second'], ['Physics/Original.goodnotes', 'native'], ['__MACOSX/._Lecture.pdf', 'junk']]);
  const result = await collectPdfSources(new Blob([data]), 'Export.zip');
  assert.equal(result.unsupported, 1);
  assert.deepEqual(result.sources.map((s) => [s.name, s.dir]), [['Notes.PDF', 'Week 1'], ['Lecture.pdf', 'Physics']]);
  assert.equal(new TextDecoder().decode(await result.sources[0].data()), '%PDF-demo');
});

test('native Goodnotes backup is reported rather than mistaken for a PDF', async () => {
  assert.deepEqual(await collectPdfSources(new Blob(['native']), 'Notebook.goodnotes'), { sources: [], unsupported: 1 });
  await assert.rejects(collectPdfSources(new Blob(['broken ZIP']), 'export.zip'));
});
