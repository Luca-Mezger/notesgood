import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const { outputFiles } = await build({ entryPoints: ['src/folders.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { folderPaths, folderRemap, folderContains, folderTarget } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));

test('synced subfolder paths produce real parents without duplicating them', () => {
  assert.deepEqual(folderPaths(['A&D / Peergrading', 'LinAlg', 'A&D', '', 'A&D / Peergrading']), ['A&D', 'A&D / Peergrading', 'LinAlg']);
  assert.equal(folderContains('Math', 'Maths'), false);
});

test('moving and renaming a folder keeps the entire subtree together', () => {
  const paths = ['A&D', 'A&D / Peergrading', 'A&D / Peergrading / Week 1', 'A&D extra', 'Semester'];
  assert.deepEqual([...folderRemap(paths, 'A&D', 'Semester / Algorithms')], [
    ['A&D', 'Semester / Algorithms'],
    ['A&D / Peergrading', 'Semester / Algorithms / Peergrading'],
    ['A&D / Peergrading / Week 1', 'Semester / Algorithms / Peergrading / Week 1'],
  ]);
  assert.deepEqual(paths, ['A&D', 'A&D / Peergrading', 'A&D / Peergrading / Week 1', 'A&D extra', 'Semester']);
});

test('folder moves refuse cycles and collisions, including implicit parents', () => {
  const paths = ['A&D', 'A&D / Peergrading', 'Archive / A&D / Week 1'];
  assert.throws(() => folderRemap(paths, 'A&D', 'A&D / Peergrading / A&D'), /inside itself/);
  assert.throws(() => folderRemap(paths, 'A&D', 'Archive / A&D'), /already exists/);
  assert.throws(() => folderRemap(paths, 'Missing', 'Moved'), /no longer exists/);
  assert.equal(folderRemap(paths, 'A&D', 'A&D').size, 0);
  assert.equal(folderTarget('A&D', '  Exercises  '), 'A&D / Exercises');
  assert.throws(() => folderTarget('A&D', 'nested / name'), /without slashes/);
});
