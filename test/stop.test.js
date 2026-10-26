// -----------------------------------------------------------------------------
// The stop on a REAL clock and a real local TCP server playing a Cube that is
// slow or silent for a while: it never waits behind a read or a command not
// yet written, and it is written within its own budget (review r1, points 2
// and 3: scenarios B, C and D).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { MaxCubeApp } from '../src/app.js';
import { registerHandlers } from '../src/handlers.js';
import { COMMAND_ACK_MS, COMMAND_BUDGET_MS } from '../src/constants.js';
import { createMemoryStore } from '../src/store.js';
import {
  DEFAULT_STATES,
  DOC_H,
  DEVICES,
  TRV,
  WALL,
  encodeC,
  encodeL,
  encodeM,
} from './fixtures/cube.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A Cube on 127.0.0.1: `mute(ms)` (no greeting, no answer meanwhile), delays for l: and s:. */
async function slowCube({ listDelay = 0, sendDelay = 0 } = {}) {
  const cube = { writes: [], connections: 0, mutedUntil: 0, listDelay, sendDelay };
  const greeting = () =>
    [DOC_H, ...encodeM(), ...DEVICES.map((d) => encodeC(d)), encodeL(DEFAULT_STATES())]
      .map((l) => `${l}\r\n`)
      .join('');
  const later = (socket, ms, fn) =>
    setTimeout(() => {
      if (!socket.destroyed) fn();
    }, ms);
  cube.server = createServer((socket) => {
    cube.connections += 1;
    socket.on('error', () => {});
    later(socket, Math.max(0, cube.mutedUntil - performance.now() + 5), () =>
      socket.write(greeting(), 'latin1'),
    );
    let pending = '';
    socket.on('data', (data) => {
      pending += data.toString('latin1');
      const parts = pending.split('\r\n');
      pending = parts.pop();
      for (const line of parts) {
        const at = performance.now();
        cube.writes.push({ line, at });
        if (at < cube.mutedUntil) continue; // never answered
        if (line === 'q:') socket.end();
        if (line === 'l:') {
          later(socket, cube.listDelay, () =>
            socket.write(`${encodeL(DEFAULT_STATES())}\r\n`, 'latin1'),
          );
        }
        if (line.startsWith('s:'))
          later(socket, cube.sendDelay, () => socket.write('S:00,0,31\r\n'));
      }
    });
  });
  await new Promise((resolve) => cube.server.listen(0, '127.0.0.1', resolve));
  cube.port = cube.server.address().port;
  cube.mute = (ms) => {
    cube.mutedUntil = performance.now() + ms;
  };
  cube.close = () => new Promise((resolve) => cube.server.close(resolve));
  cube.sends = () => cube.writes.filter((w) => w.line.startsWith('s:'));
  return cube;
}

async function running(cube) {
  const config = { host: `127.0.0.1:${cube.port}`, allow_setpoint: true, allow_mode: true };
  const gladys = createFakeGladys({ selector: 'maxcube', config });
  const quiet = () => {};
  const logger = { info: quiet, warn: quiet, error: quiet, debug: quiet };
  const app = new MaxCubeApp({ gladys, logger, store: createMemoryStore() });
  registerHandlers(gladys, app, logger);
  await gladys.connect();
  for (let i = 0; i < 200 && !app.online; i += 1) await sleep(5);
  assert.equal(app.online, true);
  for (const device of gladys.fake.discoveredDevices) await gladys.fake.deviceCreated(device);
  const set = (kind, serial, key, value) => {
    const device = gladys.devices.find((d) => d.external_id === `ext:maxcube:${kind}:${serial}`);
    const feature = device.features.find((f) => f.external_id.endsWith(`:${key}`));
    const at = performance.now();
    return gladys.fake.setValue(device, feature, value).then((ack) => ({
      ...ack,
      after: performance.now() - at,
    }));
  };
  return { app, gladys, set };
}

const stopByte = (w) => [...Buffer.from(w.line.slice(2), 'base64')][10];

test('B: a stop behind a setpoint whose read gets no answer: written in its budget', async () => {
  const cube = await slowCube();
  const { app, set } = await running(cube);
  try {
    cube.mute(1000);
    const setpoint = set('thermostat', TRV.serial, 'target', 22);
    await sleep(300);
    const asked = performance.now();
    const stop = await set('thermostat', TRV.serial, 'mode', 0);
    assert.equal(stop.success, true, stop.error);
    assert.ok(stop.after < COMMAND_ACK_MS, `answered after ${stop.after} ms`);
    const sends = cube.sends();
    assert.equal(sends.length, 1);
    assert.equal(stopByte(sends[0]), 0x49);
    assert.ok(sends[0].at - asked < COMMAND_BUDGET_MS, 'written within 3.5 s');
    const first = await setpoint;
    assert.match(first.error, /Cancelled: a stop was asked/);
  } finally {
    await app.stop();
    await cube.close();
  }
});

test('C: a stop while the loop read is in flight on a silent Cube: the read is cut', async () => {
  const cube = await slowCube();
  const { app, set } = await running(cube);
  try {
    cube.mute(500);
    app.lastReadAt = -1e9;
    void app.read(app.generation, app.epoch);
    await sleep(300);
    const asked = performance.now();
    const stop = await set('wall', WALL.serial, 'mode', 0);
    assert.equal(stop.success, true, stop.error);
    const sends = cube.sends();
    assert.equal(sends.length, 1);
    assert.ok(sends[0].at - asked < COMMAND_BUDGET_MS, 'written within 3.5 s');
    await sleep(50);
    assert.equal(app.online, true, 'the cut read is not a failure');
  } finally {
    await app.stop();
    await cube.close();
  }
});

test('D: a slow but working Cube, a setpoint then a stop: the stop leaves, the setpoint never after it', async () => {
  const cube = await slowCube({ listDelay: 1500, sendDelay: 1800 });
  const { app, set } = await running(cube);
  try {
    const setpoint = set('thermostat', TRV.serial, 'target', 22);
    await sleep(200);
    const asked = performance.now();
    const stop = await set('thermostat', TRV.serial, 'mode', 0);
    assert.equal(stop.success, true, stop.error);
    assert.ok(stop.after < COMMAND_ACK_MS, `answered after ${stop.after} ms`);
    const first = await setpoint;
    assert.equal(first.success, false);
    const sends = cube.sends();
    assert.deepEqual(sends.map(stopByte), [0x49], 'only the stop');
    assert.ok(sends[0].at - asked < COMMAND_BUDGET_MS);
  } finally {
    await app.stop();
    await cube.close();
  }
});

test('a stop behind a setpoint already written waits for its answer only, then leaves', async () => {
  const cube = await slowCube({ sendDelay: 1500 });
  const { app, set } = await running(cube);
  try {
    const setpoint = set('thermostat', TRV.serial, 'target', 22);
    await sleep(200); // the l: answered at once, the s: written, its answer 1.5 s away
    assert.equal(cube.sends().length, 1);
    const stop = await set('thermostat', TRV.serial, 'mode', 0);
    assert.equal(stop.success, true, stop.error);
    assert.equal((await setpoint).success, true);
    assert.deepEqual(
      cube.sends().map(stopByte),
      [44, 0x49],
      'the stop last (the setpoint in auto: mode bits 0)',
    );
    assert.equal(cube.connections, 1, 'no connection cut for a written command');
  } finally {
    await app.stop();
    await cube.close();
  }
});
