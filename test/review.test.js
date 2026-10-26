// -----------------------------------------------------------------------------
// The points of the first review (r1), each on the virtual clock against the
// fake Cube: the stop is protective, ordered and checked; values only from
// valid entries; the radio budget; the monotonic budget; one bad message of
// a device never stops the Cube; the configuration read again.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STOP_RESENDS, TIMEOUTS } from '../src/constants.js';
import { MODES } from '../src/cube/protocol.js';
import { BUTTON, DOC_H, TRV, WALL, WINDOW, encodeC, encodeEntry } from './fixtures/cube.js';
import {
  ALLOW,
  CONFIG,
  MINUTE,
  SECOND,
  command,
  ext,
  last,
  lastSent,
  settle,
  setup,
  status,
} from './helpers/app.js';
import { createFakeCube } from './helpers/fakeCube.js';

const T = (key) => ext('thermostat', TRV.serial, key);
const W = (key) => ext('wall', WALL.serial, key);
const X = (key) => ext('window', WINDOW.serial, key);
const byteOf = (line) => [...Buffer.from(line.slice(2), 'base64')][10];

// --- 1. The stop needs no option, no bounds, no values ------------------------------

test('r1-1: the stop is accepted with the default configuration, sent to the room', async () => {
  const { gladys, cube, start, createAll } = await setup({ config: CONFIG });
  await start();
  await createAll();
  const ack = await command(gladys, 'thermostat', TRV.serial, 'mode', 0);
  assert.deepEqual(ack, { success: true });
  assert.deepEqual(lastSent(cube), [0, 4, 0x40, 0, 0, 0, 0x0a, 0xed, 0x69, 1, 0x49]);
  const wall = await command(gladys, 'wall', WALL.serial, 'mode', '0');
  assert.deepEqual(wall, { success: true });
  assert.equal(cube.sent.length, 2);
});

test('r1-1: the stop is sent to a device not heard yet, or whose entry is not valid', async () => {
  const cube = createFakeCube({ states: [[WALL, { target: 20 }]] });
  const { gladys, start, createAll } = await setup({ cube });
  await start();
  await createAll();
  let ack = await command(gladys, 'thermostat', TRV.serial, 'mode', 0);
  assert.deepEqual(ack, { success: true }, 'not heard');
  cube.states = [[TRV, { valid: false, target: 4.5, mode: MODES.MANUAL }]];
  ack = await command(gladys, 'thermostat', TRV.serial, 'mode', 0);
  assert.deepEqual(ack, { success: true }, 'not valid: never "already off"');
  assert.equal(cube.sent.length, 2);
});

// --- 3. A command asked before a stop never leaves after it -------------------------

test('r1-3: commands of the room not written yet are cancelled by a stop; later ones pass', async () => {
  const { gladys, cube, start, createAll } = await setup({ config: ALLOW });
  await start();
  await createAll();
  cube.ignoreList = true;
  const setpoint = command(gladys, 'wall', WALL.serial, 'target', 22);
  await settle();
  const heating = command(gladys, 'thermostat', TRV.serial, 'mode', 1);
  await settle();
  cube.ignoreList = false;
  const stop = command(gladys, 'thermostat', TRV.serial, 'mode', 0);
  const [a, b, c] = await Promise.all([setpoint, heating, stop]);
  assert.match(a.error, /Cancelled: a stop was asked/);
  assert.match(b.error, /Cancelled: a stop was asked/);
  assert.deepEqual(c, { success: true });
  assert.deepEqual(cube.sent.map(byteOf), [0x49], 'only the stop left');
  // Asked after the stop: sent normally.
  const after = await command(gladys, 'thermostat', TRV.serial, 'mode', 1);
  assert.deepEqual(after, { success: true });
  assert.equal(cube.sent.length, 2);
});

// --- 4. A setpoint never starts a thermostat that is off without allow_mode ----------

test('r1-4: a setpoint on a thermostat that is off needs allow_mode', async () => {
  const cube = createFakeCube({
    states: [
      [TRV, { mode: MODES.MANUAL, target: 4.5 }],
      [WALL, { target: 20 }],
    ],
  });
  const { gladys, start, createAll } = await setup({
    cube,
    config: { ...CONFIG, allow_setpoint: true },
  });
  await start();
  await createAll();
  const ack = await command(gladys, 'thermostat', TRV.serial, 'target', 24);
  assert.match(ack.error, /This thermostat is off: a setpoint would start it again/);
  assert.equal(cube.sent.length, 0);
  const other = await setup({
    cube: createFakeCube({ states: [[TRV, { mode: MODES.MANUAL, target: 4.5 }]] }),
    config: ALLOW,
  });
  await other.start();
  await other.createAll();
  assert.deepEqual(await command(other.gladys, 'thermostat', TRV.serial, 'target', 24), {
    success: true,
  });
});

// --- 5. Checked on the follow-up reads ----------------------------------------------

test('r1-5: a stop the thermostat does not apply is sent again 3 times, then said', async () => {
  const { gladys, cube, start, createAll, wait, logger } = await setup();
  await start();
  await createAll();
  assert.deepEqual(await command(gladys, 'thermostat', TRV.serial, 'mode', 0), { success: true });
  // The L stays auto 20 °C: never applied.
  for (let i = 0; i < 60; i += 1) await wait(10 * SECOND);
  assert.equal(cube.sent.length, 1 + STOP_RESENDS);
  assert.ok(cube.sent.every((line) => byteOf(line) === 0x49));
  assert.match(
    status(gladys).message.fr,
    /L’arrêt n’a pas été appliqué par : Living room - Radiator/,
  );
  assert.ok(logger.lines.some((l) => /A stop was not applied by a thermostat: sent again/.test(l)));
  assert.ok(
    logger.lines.some((l) => /A stop sent to a thermostat was not applied \(4 send/.test(l)),
  );
  assert.ok(!logger.lines.some((l) => l.includes(TRV.serial)), 'no serial in the logs');
  // The device shows it in the end: the note goes.
  cube.states = [
    [TRV, { mode: MODES.MANUAL, target: 4.5 }],
    [WALL, { target: 20 }],
  ];
  await wait(MINUTE);
  assert.doesNotMatch(status(gladys).message.fr, /pas été appliqué/);
  assert.equal(cube.sent.length, 1 + STOP_RESENDS);
});

test('r1-5: a stop applied at the first follow-up read is not sent again', async () => {
  const { gladys, cube, start, createAll, wait } = await setup();
  await start();
  await createAll();
  await command(gladys, 'thermostat', TRV.serial, 'mode', 0);
  cube.states = [[TRV, { mode: MODES.MANUAL, target: 4.5 }]];
  await wait(5 * MINUTE);
  assert.equal(cube.sent.length, 1);
  assert.equal(last(gladys, T('mode')), 0);
});

test('r1-5: another command not applied: a warning after 2 min, not sent again', async () => {
  const { gladys, cube, start, createAll, wait, logger } = await setup({ config: ALLOW });
  await start();
  await createAll();
  assert.deepEqual(await command(gladys, 'thermostat', TRV.serial, 'target', 22), {
    success: true,
  });
  await wait(3 * MINUTE);
  assert.equal(cube.sent.length, 1);
  assert.ok(logger.lines.some((l) => /A setpoint sent to a thermostat was not applied/.test(l)));
});

// --- 6. Valid values only --------------------------------------------------------------

test('r1-6: an entry not valid or not initialized: no values, badge unreachable, commands refused', async () => {
  for (const flags of [{ valid: false }, { initialized: false }]) {
    const cube = createFakeCube({
      states: [
        [TRV, { ...flags, mode: MODES.MANUAL, target: 4.5, valve: 0, temperature: 20 }],
        [WALL, { target: 20, temperature: 21 }],
        [WINDOW, { ...flags, open: true }],
      ],
    });
    const { gladys, app, start, createAll } = await setup({ cube, config: ALLOW });
    await start();
    await createAll();
    for (const key of ['target', 'mode', 'max_mode', 'valve', 'operating', 'temperature']) {
      assert.equal(last(gladys, T(key)), undefined, key);
    }
    assert.equal(last(gladys, X('contact')), undefined);
    assert.equal(last(gladys, W('target')), 20);
    assert.equal(app.transports.get(ext('thermostat', TRV.serial)), 'unreachable');
    assert.match(
      status(gladys).message.fr,
      /2 appareils donnent des valeurs que le Cube marque comme non valables/,
    );
    const ack = await command(gladys, 'thermostat', TRV.serial, 'mode', 1);
    assert.match(ack.error, /marks the values of this device as not valid/);
    assert.deepEqual(await command(gladys, 'thermostat', TRV.serial, 'mode', 0), {
      success: true,
    });
  }
});

test('r1-6: a radio link error: only the flags, no cached value, badge unreachable', async () => {
  const cube = createFakeCube({
    states: [
      [TRV, { link: true, target: 25, valve: 40, temperature: 20 }],
      [WALL, { target: 20 }],
    ],
  });
  const { gladys, app, start, createAll } = await setup({ cube });
  await start();
  await createAll();
  assert.equal(last(gladys, T('link_error')), 1);
  assert.equal(last(gladys, T('battery_low')), 0);
  assert.equal(last(gladys, T('target')), undefined);
  assert.equal(last(gladys, T('valve')), undefined);
  assert.equal(app.transports.get(ext('thermostat', TRV.serial)), 'unreachable');
  assert.match(
    status(gladys).message.fr,
    /erreur de liaison radio : ses valeurs ne sont pas affichées/,
  );
});

// --- 7. The radio budget -------------------------------------------------------------

test('r1-7: a fresh duty cycle of 90 % or more refuses the commands, never the stop', async () => {
  const cube = createFakeCube({ hello: DOC_H.replace(',00,32,', ',5f,32,') });
  const { gladys, start, createAll } = await setup({ cube, config: ALLOW });
  await start();
  await createAll();
  const ack = await command(gladys, 'thermostat', TRV.serial, 'mode', 1);
  assert.match(ack.error, /radio budget of the Cube is almost used up \(95 %/);
  assert.equal(cube.sent.length, 0);
  assert.deepEqual(await command(gladys, 'thermostat', TRV.serial, 'mode', 0), { success: true });
  assert.equal(cube.sent.length, 1);
});

test('r1-7: an S answer at 100 % or without a free slot: "queued", and it refreshes the budget', async () => {
  const cube = createFakeCube();
  const { gladys, start, createAll } = await setup({ cube, config: ALLOW });
  await start();
  await createAll();
  cube.dutyCycle = 100;
  cube.freeSlots = 1;
  let ack = await command(gladys, 'thermostat', TRV.serial, 'target', 22);
  assert.match(ack.error, /Accepted but queued by the Cube/);
  ack = await command(gladys, 'thermostat', TRV.serial, 'target', 23);
  assert.match(ack.error, /almost used up \(100 %/, 'the S answer refreshed the duty cycle');
  assert.equal(cube.sent.length, 1);
});

test('r1-7: a duty cycle older than 10 min is neither published nor said', async () => {
  const cube = createFakeCube({ hello: DOC_H.replace(',00,32,', ',5f,32,') });
  const { gladys, app, start, createAll, wait } = await setup({ cube, config: ALLOW });
  await start();
  await createAll();
  assert.match(status(gladys).message.fr, /budget radio du Cube est à 95 %/);
  await wait(11 * MINUTE);
  assert.equal(app.duty(), undefined);
  assert.doesNotMatch(status(gladys).message.fr, /budget radio/);
  const ack = await command(gladys, 'thermostat', TRV.serial, 'mode', 1);
  assert.deepEqual(ack, { success: true }, 'a stale value refuses nothing');
});

// --- 8. The command budget on the monotonic clock -------------------------------------

test('r1-8: the wall clock jumping an hour during a command changes nothing', async () => {
  const { gladys, app, cube, start, createAll } = await setup({ config: ALLOW });
  await start();
  await createAll();
  const wall = app.now;
  let calls = 0;
  app.now = () => wall() + (calls++ > 0 ? 3_600_000 : 0);
  const ack = await command(gladys, 'thermostat', TRV.serial, 'target', 22);
  assert.deepEqual(ack, { success: true });
  assert.equal(cube.sent.length, 1);
  assert.equal(app.budget.now, app.monotonic, 'the state budget too');
});

// --- 9. One bad message of a device never stops the Cube --------------------------------

test('r1-9: a C that does not match, an L entry too short: the other devices are read', async () => {
  const cube = createFakeCube();
  const lines = cube.greet();
  // The C of the push button names the address of the wall thermostat.
  lines[lines.findIndex((l) => l.startsWith(`C:${BUTTON.rf.toLowerCase()}`))] =
    `C:${WALL.rf.toLowerCase()},${encodeC(BUTTON).split(',')[1]}`;
  const list = Buffer.from([
    3,
    0x0f,
    0x12,
    0x34,
    ...encodeEntry(TRV, { target: 21 }),
    ...encodeEntry(WINDOW, {}),
  ]);
  lines[lines.length - 1] = `L:${list.toString('base64')}`;
  cube.greeting = lines;
  const { gladys, start, createAll, logger } = await setup({ cube });
  await start();
  await createAll();
  assert.equal(status(gladys).connected, true);
  assert.equal(last(gladys, T('target')), 21);
  assert.equal(last(gladys, X('contact')), 1);
  assert.ok(logger.lines.some((l) => /1 device configuration\(s\) not readable/.test(l)));
});

// --- 10. The configuration read again ---------------------------------------------------

test('r1-10: a configuration not read is asked again without end, the status says so', async (t) => {
  const { gladys, cube, start, wait } = await setup();
  // The first read is the SDK's own (its resynchronization), then ours fail 6 times.
  let failures = 6;
  let calls = 0;
  const original = gladys.getConfig.bind(gladys);
  t.mock.method(gladys, 'getConfig', async () => {
    calls += 1;
    if (calls > 1 && failures > 0) {
      failures -= 1;
      throw new Error('busy');
    }
    return original();
  });
  await start();
  assert.match(
    status(gladys).message.fr,
    /configuration de l’intégration : nouvel essai dans 30 s/,
  );
  const ack = await gladys.fake.setValue(
    { external_id: ext('thermostat', TRV.serial) },
    { external_id: T('mode') },
    0,
  );
  assert.match(ack.error, /not loaded yet/);
  await wait(30 * SECOND);
  await wait(MINUTE);
  await wait(2 * MINUTE);
  assert.match(status(gladys).message.fr, /nouvel essai dans 4 min/);
  await wait(4 * MINUTE);
  assert.match(status(gladys).message.fr, /nouvel essai dans 8 min/);
  await wait(8 * MINUTE);
  assert.match(status(gladys).message.fr, /nouvel essai dans 10 min/, 'capped');
  await wait(10 * MINUTE);
  assert.equal(status(gladys).connected, true);
  assert.equal(cube.connections.length, 1);
});

test('r1-10: a disconnection cancels the configuration retries', async (t) => {
  const { gladys, cube, start, wait, delays } = await setup();
  let calls = 0;
  const original = gladys.getConfig.bind(gladys);
  t.mock.method(gladys, 'getConfig', async () => {
    calls += 1;
    if (calls === 1) return original();
    throw new Error('busy');
  });
  await start();
  assert.deepEqual(delays(), [30 * SECOND]);
  await gladys.disconnect();
  assert.deepEqual(delays(), []);
  await wait(MINUTE);
  assert.equal(cube.connections.length, 0);
});

// --- 12 to 16, 18 ---------------------------------------------------------------------

test('r1-14: a greeting without metadata is not a Cube', async () => {
  const cube = createFakeCube();
  cube.greeting = cube.greet().filter((l) => !l.startsWith('M:'));
  const { gladys, start } = await setup({ cube });
  await start();
  assert.equal(status(gladys).connected, false);
  assert.match(status(gladys).message.fr, /ne répond pas comme un MAX! Cube/);
});

test('r1-15: two devices on one radio address are both left out', async () => {
  const twin = { ...WALL, serial: 'LEQ0794753', name: 'Twin' };
  const cube = createFakeCube({ devices: [TRV, WALL, twin, WINDOW] });
  const { gladys, start, logger } = await setup({ cube });
  await start();
  const ids = gladys.fake.discoveredDevices.map((d) => d.external_id);
  assert.ok(!ids.includes(ext('wall', WALL.serial)));
  assert.ok(!ids.includes(ext('wall', twin.serial)));
  assert.ok(ids.includes(ext('thermostat', TRV.serial)));
  assert.ok(logger.lines.some((l) => /2 device\(s\) ignored/.test(l)));
});

test('r1-16: a pushed L updates the devices it lists, keeps the others', async () => {
  const { gladys, app, cube, start, createAll } = await setup();
  await start();
  await createAll();
  assert.equal(last(gladys, W('target')), 20);
  cube.push([[TRV, { mode: MODES.MANUAL, target: 18, valve: 10 }]]);
  await settle();
  assert.equal(last(gladys, T('target')), 18);
  const wall = app.model.devices.find((d) => d.serial === WALL.serial);
  assert.equal(wall.state?.target, 20, 'the wall thermostat keeps its state');
  assert.equal(app.transports.get(ext('wall', WALL.serial)), 'local');
  const before = gladys.fake.states.length;
  await gladys.fake.deviceUpdated(
    gladys.devices.find((d) => d.external_id === ext('wall', WALL.serial)),
  );
  await settle();
  assert.ok(gladys.fake.states.length > before);
  assert.equal(last(gladys, W('target')), 20, 'the wall thermostat kept its values');
  assert.equal(last(gladys, X('contact')), 1);
});

test('r1-12/13: a date in the temperature bytes, a setpoint out of range: not published', async () => {
  const entry = encodeEntry(TRV, { mode: MODES.AUTO, target: 20 });
  entry[9] = 0x9d; // byte 8 of the entry: the date of the documentation
  entry[10] = 0x0b;
  entry[8] = 0x7f; // byte 7 of the entry: 63.5 °C
  const cube = createFakeCube();
  cube.listLine = () => `L:${Buffer.from(entry).toString('base64')}`;
  const { gladys, start, createAll } = await setup({ cube });
  await start();
  await createAll();
  assert.equal(last(gladys, T('temperature')), undefined);
  assert.equal(last(gladys, T('target')), undefined);
  assert.equal(last(gladys, T('mode')), 3);
});

test('r1-18: a Cube whose serial is not 10 letters or digits is not a Cube', async () => {
  const cube = createFakeCube({ hello: DOC_H.replace('KEQ0523864', 'KEQ05') });
  const { gladys, start } = await setup({ cube });
  await start();
  assert.match(status(gladys).message.fr, /ne répond pas comme un MAX! Cube/);
});

test('r1-2: a stop arriving behind a read that stalls: the read is cut, no failure shown', async () => {
  const { gladys, cube, start, createAll, advance, app } = await setup();
  await start();
  await createAll();
  cube.ignoreList = true;
  await advance(MINUTE);
  cube.ignoreList = false;
  const ack = await command(gladys, 'thermostat', TRV.serial, 'mode', 0);
  assert.deepEqual(ack, { success: true });
  assert.equal(cube.connections.length, 2);
  await settle();
  assert.equal(status(gladys).connected, true, 'the cut read is not a failure');
  assert.equal(app.online, true);
  assert.ok(TIMEOUTS.STALL > 0);
});

test('r1-2: keep_connection off, the loop never closes a connection a command uses', async () => {
  const { gladys, cube, start, createAll, advance } = await setup({
    config: { ...ALLOW, keep_connection: false },
  });
  await start();
  await createAll();
  await advance(MINUTE - 1);
  const pending = command(gladys, 'thermostat', TRV.serial, 'target', 22);
  await advance(1);
  const ack = await pending;
  assert.deepEqual(ack, { success: true });
  assert.equal(cube.sent.length, 1);
  assert.equal(cube.peak, 1);
  await settle();
  assert.equal(cube.open, 0, 'closed once unused');
});
