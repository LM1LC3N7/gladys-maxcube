// -----------------------------------------------------------------------------
// The app on a REAL moving clock (performance.now, Date.now, setTimeout) and a
// real local TCP server playing the Cube: the reads really start, at 0, the
// interval and twice the interval, with a bounded number of timers. The time
// is sped up 20 times (a minute of the interval is 3 s) but it is the real
// clock: it moves between any two reads of it.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { MaxCubeApp } from '../src/app.js';
import { INTERVALS } from '../src/constants.js';
import { createMemoryStore } from '../src/store.js';
import { DOC_H, TRV, encodeC, encodeL, encodeM } from './fixtures/cube.js';

const SPEED = 20;
const INTERVAL = INTERVALS.READ_MS;

test('real clock: reads at 0, the interval and twice the interval; timers bounded', async () => {
  const reads = [];
  const greeting = [DOC_H, ...encodeM(), encodeC(TRV), encodeL([[TRV, { target: 20 }]])];
  const server = createServer((socket) => {
    socket.on('error', () => {});
    reads.push(performance.now() * SPEED);
    socket.write(`${greeting.map((l) => `${l}\r\n`).join('')}`, 'latin1');
    socket.on('data', (data) => {
      for (const line of data.toString('latin1').split('\r\n')) {
        if (line === 'l:') {
          reads.push(performance.now() * SPEED);
          socket.write(`${encodeL([[TRV, { target: 20 }]])}\r\n`, 'latin1');
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  let timersSet = 0;
  const timers = {
    setTimeout(fn, ms) {
      timersSet += 1;
      return setTimeout(fn, Math.max(0, ms) / SPEED);
    },
    clearTimeout: (id) => clearTimeout(id),
  };
  const gladys = createFakeGladys({ selector: 'maxcube', config: {} });
  await gladys.connect();
  const quiet = () => {};
  const app = new MaxCubeApp({
    gladys,
    logger: { info: quiet, warn: quiet, error: quiet, debug: quiet },
    now: () => Date.now() * SPEED,
    monotonic: () => performance.now() * SPEED,
    timers,
    store: createMemoryStore(),
  });
  const started = performance.now() * SPEED;
  try {
    await app.start({ host: `127.0.0.1:${port}` });
    const deadline = started + INTERVAL;
    while (reads.length === 0 && performance.now() * SPEED < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const until = (reads[0] ?? started) + 2.5 * INTERVAL;
    while (performance.now() * SPEED < until) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await app.stop();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  const at = reads.map((t) => Math.round(t - started));
  assert.equal(reads.length, 3, `reads at ${at}`);
  assert.ok(reads[0] - started < INTERVAL / 2, `the first read at once: ${at}`);
  for (let i = 1; i < reads.length; i += 1) {
    const gap = reads[i] - reads[i - 1];
    assert.ok(gap >= 0.9 * INTERVAL, `never sooner than the interval: ${at}`);
    assert.ok(gap < 1.5 * INTERVAL, `on time: ${at}`);
  }
  assert.ok(timersSet <= 12, `${timersSet} timers`);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});
