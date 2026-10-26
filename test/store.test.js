// -----------------------------------------------------------------------------
// The /data store (src/store.js): saves serialized, the state in memory, a
// temporary file of its own for each write. In a folder next to the tests
// (removed afterwards), never in the system temporary folder.
// -----------------------------------------------------------------------------

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFileStore } from '../src/store.js';

const dir = mkdtempSync(join(fileURLToPath(new URL('.', import.meta.url)), '.store-'));
after(() => rmSync(dir, { recursive: true, force: true }));

test('concurrent load-change-save: no change lost, the file holds the last state', async () => {
  const file = join(dir, 'state.json');
  const store = createFileStore(file);
  assert.deepEqual(store.load(), {}, 'no file yet');
  const saves = [];
  for (let i = 0; i < 50; i += 1) {
    saves.push(store.save({ ...store.load(), [`k${i}`]: i }));
  }
  await Promise.all(saves);
  const expected = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i]));
  assert.deepEqual(store.load(), expected);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), expected);
  assert.deepEqual(readdirSync(dir), ['state.json'], 'no temporary file left');
  // A new store (a restart) reads it back.
  assert.deepEqual(createFileStore(file).load(), expected);
});

test('a failed write rejects, the next ones still run', async () => {
  const file = join(dir, 'missing', 'state.json');
  const store = createFileStore(file);
  await assert.rejects(store.save({ a: 1 }));
  assert.deepEqual(store.load(), { a: 1 }, 'the state in memory is kept');
  await assert.rejects(store.save({ a: 2 }), 'queued after a failure, still run');
});
