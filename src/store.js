// -----------------------------------------------------------------------------
// The state kept in /data (the only writable place of the container): the
// time of the last read attempt, so that a restart never reads the Cube
// faster than the interval. A small JSON file. Failures are logged, never
// fatal. (From gladys-p1-monitor, through gladys-plugwise.)
//
// The state lives in memory: load() reads the file once, save() replaces the
// state at once (so a load-change-save never loses a change made by another
// one in between) and queues the write. The writes run one after the other,
// each through its own temporary file and a rename: the file always holds a
// whole state, the last one saved.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { rename, unlink, writeFile } from 'node:fs/promises';

export const DEFAULT_STATE_FILE = '/data/maxcube-state.json';

export function createFileStore(file = DEFAULT_STATE_FILE) {
  let data;
  let writes = Promise.resolve();
  let count = 0;
  const current = () => {
    if (data === undefined) {
      try {
        const read = JSON.parse(readFileSync(file, 'utf8'));
        data = read && typeof read === 'object' && !Array.isArray(read) ? read : {};
      } catch {
        data = {};
      }
    }
    return data;
  };
  return {
    load: () => structuredClone(current()),
    save(next) {
      data = structuredClone(next);
      const text = JSON.stringify(data);
      count += 1;
      const tmp = `${file}.${process.pid}.${count}.tmp`;
      const run = writes.then(async () => {
        try {
          await writeFile(tmp, text, 'utf8');
          await rename(tmp, file);
        } catch (err) {
          await unlink(tmp).catch(() => {});
          throw err;
        }
      });
      writes = run.catch(() => {});
      return run;
    },
  };
}

/** The same in memory (tests). */
export function createMemoryStore(initial = {}) {
  let data = structuredClone(initial);
  return {
    load: () => structuredClone(data),
    async save(next) {
      data = structuredClone(next);
    },
    get data() {
      return data;
    },
  };
}
