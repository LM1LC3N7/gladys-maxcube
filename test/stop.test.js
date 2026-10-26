// -----------------------------------------------------------------------------
// The stop on a REAL clock and a real local TCP server playing a Cube with ONE
// client slot (a second client is closed at once while the first is open, as
// the Cube does), slow or silent for a while: the stop never waits behind a
// read or a command not yet written, never opens a second connection, is
// tried again within its budget, and is kept and sent by the next read when
// the budget is not enough (reviews r1 and r2: scenarios B, C, D, O, SHANG,
// GREET and SCENE).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { MaxCubeApp } from '../src/app.js';
import { COMMAND_ACK_MS, COMMAND_BUDGET_MS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { createMemoryStore } from '../src/store.js';
import {
  DEFAULT_STATES,
  DEVICES,
  DOC_H,
  ROOMS,
  TRV,
  WALL,
  encodeC,
  encodeL,
  encodeM,
} from './fixtures/cube.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A Cube on 127.0.0.1 with one client slot. `mute(ms)`: no greeting and no
 * answer meanwhile; `greetDelay` (-1: never); delays for l: and s:;
 * `ignoreSend`: s: never answered.
 */
async function slowCube({
  listDelay = 0,
  sendDelay = 0,
  devices = DEVICES,
  rooms = ROOMS,
  states = DEFAULT_STATES(),
} = {}) {
  const cube = {
    writes: [],
    connections: 0,
    refused: 0,
    open: 0,
    peak: 0,
    mutedUntil: 0,
    greetDelay: 0,
    listDelay,
    sendDelay,
    ignoreSend: false,
    /** The greeting line by line, this many ms apart (a slow Cube still talking). */
    trickleMs: 0,
    sockets: [],
  };
  const greeting = () =>
    [DOC_H, ...encodeM(rooms, devices), ...devices.map((d) => encodeC(d)), encodeL(states)]
      .map((l) => `${l}\r\n`)
      .join('');
  const later = (socket, ms, fn) =>
    setTimeout(() => {
      if (!socket.destroyed) fn();
    }, ms);
  cube.server = createServer((socket) => {
    socket.on('error', () => {});
    if (cube.open >= 1) {
      // One client only: the second is closed at once.
      cube.refused += 1;
      socket.destroy();
      return;
    }
    cube.connections += 1;
    cube.open += 1;
    cube.peak = Math.max(cube.peak, cube.open);
    cube.sockets.push(socket);
    socket.on('close', () => {
      cube.open -= 1;
    });
    if (cube.greetDelay >= 0) {
      const start = Math.max(0, cube.mutedUntil - performance.now() + 5, cube.greetDelay);
      if (cube.trickleMs > 0) {
        const lines = greeting().split(/(?<=\r\n)/);
        lines.forEach((line, i) =>
          later(socket, start + i * cube.trickleMs, () => socket.write(line, 'latin1')),
        );
      } else {
        later(socket, start, () => socket.write(greeting(), 'latin1'));
      }
    }
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
          later(socket, cube.listDelay, () => socket.write(`${encodeL(states)}\r\n`, 'latin1'));
        }
        if (line.startsWith('s:') && !cube.ignoreSend) {
          later(socket, cube.sendDelay, () => socket.write('S:00,0,31\r\n'));
        }
      }
    });
  });
  await new Promise((resolve) => cube.server.listen(0, '127.0.0.1', resolve));
  cube.port = cube.server.address().port;
  cube.mute = (ms) => {
    cube.mutedUntil = performance.now() + ms;
  };
  cube.close = () => {
    for (const socket of cube.sockets) socket.destroy();
    return new Promise((resolve) => cube.server.close(resolve));
  };
  cube.sends = () => cube.writes.filter((w) => w.line.startsWith('s:'));
  return cube;
}

async function running(cube, extra = {}) {
  const config = {
    host: `127.0.0.1:${cube.port}`,
    allow_setpoint: true,
    allow_mode: true,
    ...extra,
  };
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

const lastByte = (w) => [...Buffer.from(w.line.slice(2), 'base64')][10];
const roomOf = (w) => [...Buffer.from(w.line.slice(2), 'base64')][9];

test('B: a stop behind a setpoint whose read gets no answer: written in its budget, one client', async () => {
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
    assert.equal(lastByte(sends[0]), 0x49);
    assert.ok(sends[0].at - asked < COMMAND_BUDGET_MS, 'written within 3.5 s');
    assert.match((await setpoint).error, /Cancelled: a stop was asked/);
    assert.equal(cube.peak, 1);
  } finally {
    await app.stop();
    await cube.close();
  }
});

test('C: a stop while the loop read is in flight on a silent Cube: cut after 1 s, one client', async () => {
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
    assert.equal(cube.peak, 1);
    await sleep(50);
    assert.equal(app.online, true, 'the read is not a failure');
  } finally {
    await app.stop();
    await cube.close();
  }
});

test('D: a slow but working Cube, a setpoint then a stop: the stop leaves, the setpoint never', async () => {
  const cube = await slowCube({ listDelay: 1500, sendDelay: 1800 });
  const { app, set } = await running(cube);
  try {
    const setpoint = set('thermostat', TRV.serial, 'target', 22);
    await sleep(200);
    const asked = performance.now();
    const stop = await set('thermostat', TRV.serial, 'mode', 0);
    assert.equal(stop.success, true, stop.error);
    assert.ok(stop.after < COMMAND_ACK_MS, `answered after ${stop.after} ms`);
    assert.equal((await setpoint).success, false);
    const sends = cube.sends();
    assert.deepEqual(sends.map(lastByte), [0x49], 'only the stop');
    assert.ok(sends[0].at - asked < COMMAND_BUDGET_MS);
    assert.equal(cube.peak, 1);
  } finally {
    await app.stop();
    await cube.close();
  }
});

test('O: a setpoint in progress and heating asked before a stop of the room: only the stop leaves', async () => {
  const cube = await slowCube({ listDelay: 300 });
  const { app, set } = await running(cube);
  try {
    const setpoint = set('wall', WALL.serial, 'target', 22);
    await sleep(100);
    const heating = set('thermostat', TRV.serial, 'mode', 1);
    await sleep(100);
    const stop = await set('thermostat', TRV.serial, 'mode', 0);
    assert.equal(stop.success, true, stop.error);
    assert.match((await setpoint).error, /Cancelled/);
    assert.match((await heating).error, /Cancelled/);
    await sleep(100);
    assert.deepEqual(cube.sends().map(lastByte), [0x49]);
    assert.equal(cube.peak, 1);
  } finally {
    await app.stop();
    await cube.close();
  }
});

test('SHANG: a stop behind a setpoint written without answer: tried again on a new connection', async () => {
  const cube = await slowCube();
  const { app, set } = await running(cube);
  try {
    cube.ignoreSend = true;
    const setpoint = set('thermostat', TRV.serial, 'target', 22);
    while (cube.sends().length === 0) await sleep(5);
    await sleep(100);
    cube.ignoreSend = false;
    const asked = performance.now();
    const stop = await set('wall', WALL.serial, 'mode', 0);
    assert.equal(stop.success, true, stop.error);
    const sends = cube.sends();
    assert.equal(sends.length, 2);
    assert.equal(lastByte(sends[1]), 0x49);
    assert.ok(sends[1].at - asked < COMMAND_BUDGET_MS, 'written within 3.5 s');
    assert.equal((await setpoint).success, false);
    assert.equal(cube.peak, 1);
  } finally {
    await app.stop();
    await cube.close();
  }
});

test('GREET: a stop during a greeting that never comes (keep_connection off): cut, sent', async () => {
  const cube = await slowCube();
  const { app, set } = await running(cube, { keep_connection: false });
  try {
    await sleep(300); // the first connection closed
    cube.greetDelay = -1;
    app.lastReadAt = -1e9;
    void app.read(app.generation, app.epoch);
    await sleep(100);
    cube.greetDelay = 0; // the next connections are greeted
    const asked = performance.now();
    const stop = await set('thermostat', TRV.serial, 'mode', 0);
    assert.equal(stop.success, true, stop.error);
    const sends = cube.sends();
    assert.equal(sends.length, 1);
    assert.ok(sends[0].at - asked < COMMAND_BUDGET_MS, 'written within 3.5 s');
    assert.equal(cube.peak, 1);
    assert.equal(cube.refused, 0, 'the cut greeting closed before the new connection');
  } finally {
    await app.stop();
    await cube.close();
  }
});

test('a slow greeting still coming is waited for by a stop, never cut', async () => {
  const cube = await slowCube();
  const { app, set } = await running(cube, { keep_connection: false });
  try {
    await sleep(300);
    cube.trickleMs = 300; // a line every 0.3 s: about 2 s in all, no pause of 1 s
    app.lastReadAt = -1e9;
    void app.read(app.generation, app.epoch);
    await sleep(100);
    const before = cube.connections;
    const stop = await set('thermostat', TRV.serial, 'mode', 0);
    assert.equal(stop.success, true, stop.error);
    assert.equal(cube.connections, before, 'no new connection: the greeting was not cut');
    assert.equal(cube.sends().length, 1);
  } finally {
    await app.stop();
    await cube.close();
  }
});

test('r3: a stop kept for the next read, then heating of the room already so: the stop never leaves', async () => {
  const devices = [1, 2, 3, 4, 5].map((r) => ({
    type: 1,
    rf: `0A000${r}`,
    serial: `KEQ000000${r}`,
    name: `T${r}`,
    room: r,
  }));
  const rooms = devices.map((d) => ({ id: d.room, name: `Room ${d.room}`, rf: d.rf }));
  const states = devices.map((d, i) => [
    d,
    i === 4 ? { mode: 1, valve: 20, target: 21 } : { mode: 0, valve: 20, target: 21 },
  ]);
  const cube = await slowCube({ devices, rooms, states, sendDelay: 900 });
  const { app, set } = await running(cube);
  try {
    const acks = await Promise.all(devices.map((d) => set('thermostat', d.serial, 'mode', 0)));
    assert.match(acks[4].error ?? '', /Stop not sent yet/, 'the 5th stop is kept');
    const heat = await set('thermostat', 'KEQ0000005', 'mode', 1);
    assert.equal(heat.success, true, heat.error);
    await sleep(8000);
    assert.deepEqual(
      cube.sends().filter((w) => roomOf(w) === 5),
      [],
      'no stop for room 5 after the heating',
    );
  } finally {
    await app.stop();
    await cube.close();
  }
});

test('SCENE: "all off" in 5 rooms, S answered in 900 ms: every stop leaves, late ones at the next read', async () => {
  const devices = [1, 2, 3, 4, 5].map((r) => ({
    type: 1,
    rf: `0A000${r}`,
    serial: `KEQ000000${r}`,
    name: `T${r}`,
    room: r,
  }));
  const rooms = devices.map((d) => ({ id: d.room, name: `Room ${d.room}`, rf: d.rf }));
  const states = devices.map((d) => [d, { mode: 0, valve: 20, target: 21 }]);
  const cube = await slowCube({ devices, rooms, states, sendDelay: 900 });
  const { app, gladys, set } = await running(cube);
  try {
    const acks = await Promise.all(devices.map((d) => set('thermostat', d.serial, 'mode', 0)));
    assert.ok(acks.filter((a) => a.success).length >= 3);
    for (const ack of acks.filter((a) => !a.success)) {
      assert.match(ack.error, /Stop not sent yet: .* next read/);
    }
    assert.ok(acks.every((a) => a.after < COMMAND_ACK_MS + 100));
    if (acks.some((a) => !a.success)) {
      assert.match(gladys.fake.connectionStatus.message.en, /A stop could not be sent yet to/);
    }
    for (let i = 0; i < 200 && cube.sends().length < 5; i += 1) await sleep(50);
    assert.deepEqual(
      cube
        .sends()
        .map(roomOf)
        .sort((a, b) => a - b),
      [1, 2, 3, 4, 5],
      'every room got its stop',
    );
    assert.ok(cube.sends().every((w) => lastByte(w) === 0x49));
    assert.equal(cube.peak, 1);
  } finally {
    await app.stop();
    await cube.close();
  }
});
