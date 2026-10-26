// -----------------------------------------------------------------------------
// The integration against the SDK's fake Gladys and a fake Cube, through the
// exact wiring of the container (src/handlers.js), on a virtual clock that
// moves at each read of it.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { INTERVALS, READ_AFTER_COMMAND_MS, TIMEOUTS } from '../src/constants.js';
import { MODES } from '../src/cube/protocol.js';
import { createMemoryStore } from '../src/store.js';
import { BUTTON, CUBE_SERIAL, TRV, WALL, WINDOW, encodeC } from './fixtures/cube.js';
import {
  ALLOW,
  CONFIG,
  MINUTE,
  NOW,
  SECOND,
  command,
  deviceOf,
  ext,
  featureOf,
  last,
  lastSent,
  settle,
  setup,
  status,
} from './helpers/app.js';
import { createFakeCube } from './helpers/fakeCube.js';

const listsOf = (cube) => cube.lines.filter((l) => l === 'l:').length;
const T = (key) => ext('thermostat', TRV.serial, key);
const W = (key) => ext('wall', WALL.serial, key);
const X = (key) => ext('window', WINDOW.serial, key);
const C = (key) => ext('cube', CUBE_SERIAL, key);

// --- Configuration and lifecycle ------------------------------------------------------

test('configuration problems: said in the status, nothing is called', async () => {
  for (const [config, pattern] of [
    [{}, /Saisissez l’adresse du MAX! Cube/],
    [{ host: 'http://192.168.1.40' }, /sans http:\/\//],
    [{ host: 'u:p@192.168.1.40' }, /Retirez l’identifiant/],
    [{ host: '192.168.1.40/path' }, /n’est pas valide/],
    [{ host: '192.168.1.40:99999' }, /n’est pas valide/],
  ]) {
    const { gladys, cube, start, delays } = await setup({ config });
    await start();
    assert.equal(status(gladys).connected, false);
    assert.match(status(gladys).message.fr, pattern);
    assert.equal(cube.connections.length, 0);
    assert.deepEqual(delays(), []);
  }
});

test('the greeting: the Cube and its devices in Discovery, no value before creation', async () => {
  const { gladys, cube, start } = await setup();
  await start();
  assert.equal(cube.connections.length, 1);
  assert.deepEqual(cube.addresses[0], { host: '192.168.1.40', port: 62910, timeoutMs: 3000 });
  const discovered = gladys.fake.discoveredDevices;
  assert.deepEqual(
    discovered.map((d) => d.external_id).sort(),
    [
      ext('cube', CUBE_SERIAL),
      ext('thermostat', TRV.serial),
      ext('wall', WALL.serial),
      ext('window', WINDOW.serial),
    ].sort(),
  );
  assert.ok(
    !JSON.stringify(discovered).includes(BUTTON.serial),
    'the push button is not published',
  );
  const trv = discovered.find((d) => d.external_id === ext('thermostat', TRV.serial));
  assert.equal(trv.name, 'Living room - Radiator (thermostat de radiateur MAX!)');
  assert.deepEqual(
    trv.features.map((f) => f.external_id.split(':').at(-1)),
    [
      'temperature',
      'target',
      'mode',
      'max_mode',
      'battery_low',
      'link_error',
      'operating',
      'valve',
    ],
  );
  const target = trv.features.find((f) => f.external_id === T('target'));
  assert.equal(target.read_only, false);
  assert.equal(target.min, 4.5, 'the off setpoint can be shown');
  assert.equal(target.max, 30);
  assert.equal(target.unit, 'celsius');
  const window = discovered.find((d) => d.external_id === ext('window', WINDOW.serial));
  assert.equal(window.name, 'Bedroom - Window (contact de fenêtre MAX!)');
  assert.equal(window.features[0].category, 'opening-sensor');
  assert.ok(
    discovered.every((d) =>
      d.features.every((f) => f.read_only || /target|mode/.test(f.external_id)),
    ),
  );
  assert.equal(gladys.fake.states.length, 0);
  assert.equal(status(gladys).connected, true);
  assert.match(
    status(gladys).message.fr,
    /Connecté au MAX! Cube KEQ0523864 \(firmware 1\.1\.3\) : 3 appareils dans 2 pièces/,
  );
  assert.match(status(gladys).message.fr, /Créez-les depuis l’onglet « Découverte »/);
  assert.match(status(gladys).message.en, /3 devices in 2 rooms/);
});

test('created devices: the values of the last read, the badges, the status', async () => {
  const { gladys, cube, start, createAll } = await setup();
  await start();
  await createAll();
  assert.equal(last(gladys, T('temperature')), 19.5);
  assert.equal(last(gladys, T('target')), 20);
  assert.equal(last(gladys, T('mode')), 3, 'auto');
  assert.equal(last(gladys, T('max_mode')), 'auto');
  assert.equal(last(gladys, T('operating')), 1, 'the valve is open');
  assert.equal(last(gladys, T('valve')), 30);
  assert.equal(last(gladys, T('battery_low')), 0);
  assert.equal(last(gladys, T('link_error')), 0);
  assert.equal(last(gladys, W('temperature')), 21.3);
  assert.equal(last(gladys, W('target')), 20);
  assert.equal(last(gladys, X('contact')), 1, 'closed');
  assert.equal(last(gladys, C('duty_cycle')), 0);
  assert.equal(last(gladys, C('free_slots')), 50);
  assert.ok(gladys.fake.transports.every((t) => t.transport === 'local'));
  assert.doesNotMatch(status(gladys).message.fr, /Découverte/);
  assert.equal(listsOf(cube), 0, 'the greeting gave the values: no l: yet');
});

test('the reading loop: l: every minute on the connection kept, never sooner; pushes at once', async () => {
  const { gladys, cube, start, createAll, wait, delays } = await setup();
  await start();
  await createAll();
  assert.deepEqual(delays().map(Math.round), [MINUTE]);
  await wait(59 * SECOND);
  assert.equal(listsOf(cube), 0);
  cube.states = [
    [TRV, { mode: MODES.MANUAL, valve: 0, target: 22, temperature: 20.1, battery: true }],
    [WALL, { mode: MODES.MANUAL, target: 22, temperature: 21.3 }],
    [WINDOW, { open: true }],
  ];
  await wait(SECOND);
  assert.equal(listsOf(cube), 1);
  assert.equal(cube.connections.length, 1, 'the connection is kept');
  assert.equal(last(gladys, T('target')), 22);
  assert.equal(last(gladys, T('mode')), 1, 'heating');
  assert.equal(last(gladys, T('max_mode')), 'manual');
  assert.equal(last(gladys, T('operating')), 0);
  assert.equal(last(gladys, T('battery_low')), 1);
  assert.equal(last(gladys, X('contact')), 0, 'open');
  assert.match(status(gladys).message.fr, /1 appareil signale une pile faible/);
  await wait(MINUTE);
  assert.equal(listsOf(cube), 2);
  // A push between two reads: published without a read.
  cube.push([
    [TRV, { mode: MODES.MANUAL, valve: 0, target: 4.5, temperature: 20.1 }],
    [WALL, { mode: MODES.MANUAL, target: 22, temperature: 21.3 }],
    [WINDOW, { open: false }],
  ]);
  await settle();
  assert.equal(last(gladys, T('target')), 4.5);
  assert.equal(last(gladys, T('mode')), 0, 'off: the valve closed');
  assert.equal(last(gladys, X('contact')), 1);
  assert.equal(listsOf(cube), 2);
  assert.equal(
    cube.lines.filter((l) => !/^[lsq]:/.test(l)).length,
    0,
    'nothing else is ever written',
  );
});

test('keep_connection off: a connection per read, closed with q:, one at a time', async () => {
  const { gladys, cube, start, createAll, wait } = await setup({
    config: { ...CONFIG, keep_connection: false },
  });
  await start();
  assert.equal(cube.connections.length, 1);
  assert.equal(cube.connections[0].open, false, 'closed after the greeting');
  assert.deepEqual(cube.connections[0].lines, ['q:']);
  await createAll();
  assert.equal(last(gladys, T('target')), 20);
  await wait(MINUTE);
  assert.equal(cube.connections.length, 2);
  assert.equal(cube.connections[1].open, false);
  assert.equal(cube.peak, 1);
  assert.equal(listsOf(cube), 0, 'the greeting of each connection gives the values');
});

test('a device the Cube has not heard: no values, badge unreachable, the status says so', async () => {
  const cube = createFakeCube({ states: [[TRV, { valve: 10, target: 21 }]] });
  const { gladys, app, start, createAll } = await setup({ cube });
  await start();
  await createAll();
  assert.equal(last(gladys, T('target')), 21);
  assert.equal(last(gladys, W('target')), undefined);
  const badge = (id) => app.transports.get(id);
  assert.equal(badge(ext('wall', WALL.serial)), 'unreachable');
  assert.equal(badge(ext('window', WINDOW.serial)), 'unreachable');
  assert.equal(badge(ext('thermostat', TRV.serial)), 'local');
  assert.match(status(gladys).message.fr, /2 appareils ne donnent pas encore de valeurs/);
});

test('unreachable: retried 1, 2, 4 min... never sooner than the interval; recovery', async () => {
  const cube = createFakeCube();
  cube.refuse = true;
  const { gladys, app, start, wait, delays, createAll } = await setup({ cube });
  await start();
  assert.equal(status(gladys).connected, false);
  assert.match(status(gladys).message.fr, /pas de connexion/);
  assert.match(status(gladys).message.fr, /Un seul client à la fois/);
  assert.match(status(gladys).message.fr, /Nouvel essai dans 1 min/);
  assert.deepEqual(delays().map(Math.round), [MINUTE]);
  await wait(MINUTE);
  assert.equal(cube.connections.length, 0);
  assert.equal(cube.addresses.length, 2);
  assert.match(status(gladys).message.fr, /Nouvel essai dans 2 min/);
  await wait(MINUTE);
  assert.equal(cube.addresses.length, 2, 'not before 2 min');
  await wait(MINUTE);
  assert.equal(cube.addresses.length, 3);
  assert.match(status(gladys).message.fr, /Nouvel essai dans 4 min/);
  cube.refuse = false;
  await wait(4 * MINUTE);
  assert.equal(status(gladys).connected, true);
  await createAll();
  assert.equal(last(gladys, T('target')), 20);
  // Lost again: the badges go unreachable, the retry starts at 1 min again.
  cube.silent = true;
  cube.dropAll();
  await wait(MINUTE + TIMEOUTS.CONNECT);
  assert.equal(status(gladys).connected, false);
  assert.match(status(gladys).message.fr, /pas de réponse à temps/);
  assert.match(status(gladys).message.fr, /Nouvel essai dans 1 min/);
  assert.ok([...app.transports.values()].every((t) => t === 'unreachable'));
  assert.equal(app.transports.size, 4);
});

test('a silent or foreign server: timeout, then "not a Cube"; the connection is closed', async () => {
  const cube = createFakeCube();
  cube.silent = true;
  const { gladys, start, wait } = await setup({ cube });
  await start();
  await wait(TIMEOUTS.CONNECT);
  assert.equal(status(gladys).connected, false);
  assert.match(status(gladys).message.fr, /pas de réponse à temps/);
  assert.equal(cube.connections[0].open, false);
  cube.silent = false;
  cube.greeting = ['220 smtp.example.org ESMTP', 'L:!!!!'];
  await wait(MINUTE);
  assert.match(status(gladys).message.fr, /ne répond pas comme un MAX! Cube/);
  assert.equal(cube.connections[1].open, false);
});

test('a restart soon after a read waits for the rest of the interval (/data)', async () => {
  const store = createMemoryStore({ lastAttemptAt: NOW - 20 * SECOND });
  const { gladys, cube, start, wait, delays } = await setup({ store });
  await start();
  assert.equal(cube.connections.length, 0);
  assert.match(status(gladys).message.fr, /prochaine lecture dans 40 s/);
  assert.deepEqual(delays().map(Math.round), [40 * SECOND]);
  await wait(39 * SECOND);
  assert.equal(cube.connections.length, 0);
  await wait(SECOND);
  assert.equal(cube.connections.length, 1);
  assert.equal(store.data.lastAttemptAt, NOW + 40 * SECOND, 'written before the read');
  // A time in the future (a clock set back) does not block.
  const ahead = createMemoryStore({ lastAttemptAt: NOW + 3600 * SECOND });
  const other = await setup({ store: ahead });
  await other.start();
  assert.equal(other.cube.connections.length, 1);
});

test('Gladys reconnects: everything published again, the connection and the loop kept', async () => {
  const { gladys, cube, start, createAll, wait, delays } = await setup();
  await start();
  await createAll();
  await wait(30 * SECOND);
  await gladys.disconnect();
  await settle();
  assert.equal(cube.connections[0].open, true);
  const before = gladys.fake.states.length;
  await gladys.connect();
  await wait(0);
  assert.equal(cube.connections.length, 1, 'no new connection');
  assert.equal(listsOf(cube), 0, 'no read sooner than the interval');
  assert.ok(gladys.fake.states.length > before, 'the states are sent again');
  assert.equal(status(gladys).connected, true);
  assert.deepEqual(delays().map(Math.round), [30 * SECOND]);
  await wait(30 * SECOND);
  assert.equal(listsOf(cube), 1);
  // Saving the same configuration again changes nothing either.
  await gladys.fake.configUpdated(CONFIG);
  await wait(0);
  assert.equal(cube.connections.length, 1);
  assert.equal(listsOf(cube), 1);
  // A new address: a new connection, after a minute (never sooner than the interval).
  await gladys.fake.configUpdated({ host: '192.168.1.41' });
  await wait(0);
  assert.equal(cube.connections[0].open, false, 'the old one is closed');
  assert.equal(cube.connections.length, 1);
  await wait(MINUTE);
  assert.equal(cube.connections.length, 2);
  assert.equal(cube.addresses.at(-1).host, '192.168.1.41');
});

test('the connection is renewed every 6 h (fresh rooms and names)', async () => {
  const { cube, start, wait } = await setup();
  await start();
  await wait(INTERVALS.RECONNECT_MS - MINUTE);
  assert.equal(cube.connections.length, 1);
  await wait(MINUTE);
  assert.equal(cube.connections.length, 2);
  assert.equal(cube.connections[0].open, false);
  assert.equal(cube.peak, 1);
});

test('stop: q: is sent, the timer cleared', async () => {
  const { app, cube, start, delays } = await setup();
  await start();
  await app.stop();
  assert.equal(cube.connections[0].open, false);
  assert.deepEqual(cube.connections[0].lines, ['q:']);
  assert.deepEqual(delays(), []);
});

// --- Commands ---------------------------------------------------------------------

test('commands are off by default: refused with the option to tick, nothing written', async () => {
  const { gladys, cube, start, createAll } = await setup();
  await start();
  await createAll();
  let ack = await command(gladys, 'thermostat', TRV.serial, 'target', 21);
  assert.equal(ack.success, false);
  assert.match(ack.error, /Allow the setpoint commands/);
  for (const mode of [1, 3]) {
    ack = await command(gladys, 'wall', WALL.serial, 'mode', mode);
    assert.equal(ack.success, false);
    assert.match(ack.error, /Allow the mode commands/);
  }
  assert.equal(cube.sent.length, 0);
  assert.equal(listsOf(cube), 0, 'nothing is read for a refused command');
});

test('setpoint: a fresh l: first, then command 40 to the room, auto kept; read again 5 s later', async () => {
  const { gladys, cube, start, createAll, wait, delays } = await setup({ config: ALLOW });
  await start();
  await createAll();
  const ack = await command(gladys, 'thermostat', TRV.serial, 'target', 21.5);
  assert.deepEqual(ack, { success: true });
  assert.equal(listsOf(cube), 1, 'read just before acting');
  assert.deepEqual(
    lastSent(cube),
    [0, 4, 0x40, 0, 0, 0, 0x0a, 0xed, 0x69, 1, 0x2b],
    'auto, 21.5 °C',
  );
  assert.ok(cube.lines.indexOf('l:') < cube.lines.findIndex((l) => l.startsWith('s:')));
  assert.deepEqual(delays().map(Math.round), [READ_AFTER_COMMAND_MS]);
  cube.states = [
    [TRV, { valve: 60, target: 21.5, temperature: 19.5 }],
    [WALL, { target: 20, temperature: 21 }],
  ];
  await wait(READ_AFTER_COMMAND_MS);
  assert.equal(last(gladys, T('target')), 21.5);
  assert.equal(listsOf(cube), 2);
  assert.deepEqual(delays().map(Math.round), [25 * SECOND], 'the next follow-up read (30 s)');
  // The wall thermostat: the same command, its own address.
  await command(gladys, 'wall', WALL.serial, 'target', 18);
  assert.deepEqual(lastSent(cube).slice(6), [0x0f, 0xc3, 0x80, 1, 0x24]);
  // In manual: manual kept. In boost: manual (the boost ends).
  cube.states = [[TRV, { mode: MODES.BOOST, valve: 100, target: 20 }]];
  await command(gladys, 'thermostat', TRV.serial, 'target', 19);
  assert.equal(lastSent(cube)[10], 0x40 | 38);
  // Rounded to the half degree.
  await command(gladys, 'thermostat', TRV.serial, 'target', '21.3');
  assert.equal(lastSent(cube)[10], 0x40 | 43);
  // The duty cycle and the free slots of the S answer are published at the next read.
  assert.equal(cube.sent.length, 4);
});

test('setpoint: out of bounds, not a number, or the device bounds: refused, never clamped', async () => {
  const { gladys, cube, start, createAll } = await setup({ config: ALLOW });
  await start();
  await createAll();
  for (const value of [31, 4.9, 4.5, 0, -5, '21,5', null, '', true, ' 21', '0x15', NaN]) {
    const ack = await command(gladys, 'thermostat', TRV.serial, 'target', value);
    assert.equal(ack.success, false, String(value));
    assert.match(ack.error, /from 5 to 30 °C/);
  }
  assert.equal(cube.sent.length, 0);
  assert.equal(listsOf(cube), 0, 'an invalid value is refused before any read');
});

test('setpoint: the bounds of every thermostat of the room narrow the range, never clamped', async () => {
  // The wall thermostat allows 8-25 °C: the radiator one of the same room follows it.
  const cube = createFakeCube();
  const lines = cube.greet();
  lines[lines.findIndex((l) => l.startsWith(`C:${WALL.rf.toLowerCase()}`))] = encodeC(WALL, {
    min: 8,
    max: 25,
  });
  cube.greeting = lines;
  const { gladys, start, createAll } = await setup({ cube, config: ALLOW });
  await start();
  await createAll();
  const target = featureOf(gladys, 'wall', WALL.serial, 'target');
  assert.equal(target.min, 4.5);
  assert.equal(target.max, 25);
  let ack = await command(gladys, 'wall', WALL.serial, 'target', 26);
  assert.equal(ack.success, false);
  assert.match(ack.error, /from 8 to 25 °C/);
  ack = await command(gladys, 'wall', WALL.serial, 'target', 7.5);
  assert.match(ack.error, /from 8 to 25 °C/);
  ack = await command(gladys, 'thermostat', TRV.serial, 'target', 27); // the room: the wall bounds
  assert.match(ack.error, /from 8 to 25 °C/);
  ack = await command(gladys, 'wall', WALL.serial, 'target', 25);
  assert.equal(ack.success, true);
  assert.equal(cube.sent.length, 1);
});

test('bounds that leave nothing: setpoint refused, the stop still sent', async () => {
  const cube = createFakeCube();
  const lines = cube.greet();
  lines[lines.findIndex((l) => l.startsWith(`C:${TRV.rf.toLowerCase()}`))] = encodeC(TRV, {
    min: 25,
    max: 10,
  });
  cube.greeting = lines;
  const { gladys, start, createAll } = await setup({ cube, config: ALLOW });
  await start();
  await createAll();
  let ack = await command(gladys, 'thermostat', TRV.serial, 'target', 20);
  assert.match(ack.error, /leave no valid value/);
  ack = await command(gladys, 'wall', WALL.serial, 'target', 20);
  assert.match(ack.error, /leave no valid value/, 'the same room');
  assert.equal(cube.sent.length, 0);
  ack = await command(gladys, 'thermostat', TRV.serial, 'mode', 0);
  assert.deepEqual(ack, { success: true });
  assert.equal(lastSent(cube)[10], 0x49);
});

test('mode: off (manual 4.5 °C), auto (back to the programme), heating (manual at the comfort temperature)', async () => {
  const { gladys, cube, start, createAll } = await setup({ config: ALLOW });
  await start();
  await createAll();
  let ack = await command(gladys, 'thermostat', TRV.serial, 'mode', 0);
  assert.deepEqual(ack, { success: true });
  assert.equal(lastSent(cube)[10], 0x49, 'manual 4.5');
  // Now off: auto goes back to the programme (temperature 0).
  cube.states = [[TRV, { mode: MODES.MANUAL, valve: 0, target: 4.5 }]];
  ack = await command(gladys, 'thermostat', TRV.serial, 'mode', 3);
  assert.equal(ack.success, true);
  assert.equal(lastSent(cube)[10], 0x00);
  // Heating from off: manual at the comfort temperature of the C message (21 °C).
  ack = await command(gladys, 'thermostat', TRV.serial, 'mode', '1');
  assert.equal(ack.success, true);
  assert.equal(lastSent(cube)[10], 0x40 | 42);
  // Heating from auto at 20 °C: manual at 20 °C.
  cube.states = [[TRV, { mode: MODES.AUTO, valve: 10, target: 20 }]];
  ack = await command(gladys, 'thermostat', TRV.serial, 'mode', 1);
  assert.equal(ack.success, true);
  assert.equal(lastSent(cube)[10], 0x40 | 40);
  // Cooling and other values: refused before any read.
  const lists = listsOf(cube);
  ack = await command(gladys, 'thermostat', TRV.serial, 'mode', 2);
  assert.match(ack.error, /does not cool/);
  ack = await command(gladys, 'thermostat', TRV.serial, 'mode', 4);
  assert.match(ack.error, /0 \(off\), 1 \(heating\) or 3 \(auto/);
  ack = await command(gladys, 'thermostat', TRV.serial, 'mode', null);
  assert.equal(ack.success, false);
  assert.equal(listsOf(cube), lists);
  // Features that are not commands.
  ack = await command(gladys, 'thermostat', TRV.serial, 'valve', 50);
  assert.match(ack.error, /Unknown MAX! feature/);
  ack = await command(gladys, 'window', WINDOW.serial, 'contact', 1);
  assert.match(ack.error, /Unknown MAX! feature/);
  assert.equal(cube.sent.length, 4);
});

test('already in the state asked: nothing sent, acknowledged', async () => {
  const { gladys, cube, start, createAll } = await setup({ config: ALLOW });
  await start();
  await createAll();
  // Auto at 20 °C: the setpoint 20 and the mode auto are already there.
  let ack = await command(gladys, 'thermostat', TRV.serial, 'target', 20);
  assert.deepEqual(ack, { success: true });
  ack = await command(gladys, 'thermostat', TRV.serial, 'mode', 3);
  assert.deepEqual(ack, { success: true });
  assert.equal(cube.sent.length, 0);
  assert.equal(listsOf(cube), 2, 'still read before deciding');
  // Heating while the room is manual at 21: already.
  cube.states = [
    [TRV, { mode: MODES.MANUAL, valve: 20, target: 21 }],
    [WALL, { mode: MODES.MANUAL, target: 21 }],
  ];
  ack = await command(gladys, 'thermostat', TRV.serial, 'mode', 1);
  assert.deepEqual(ack, { success: true });
  assert.equal(cube.sent.length, 0);
  // Another thermostat of the room elsewhere: not "already", sent.
  cube.states = [
    [TRV, { mode: MODES.MANUAL, valve: 20, target: 21 }],
    [WALL, { mode: MODES.AUTO, target: 18 }],
  ];
  ack = await command(gladys, 'thermostat', TRV.serial, 'target', 21);
  assert.deepEqual(ack, { success: true });
  assert.equal(cube.sent.length, 1);
  // A stop is always sent (idempotent), even when the device shows it off.
  cube.states = [[TRV, { mode: MODES.MANUAL, valve: 0, target: 4.5 }]];
  ack = await command(gladys, 'thermostat', TRV.serial, 'mode', 0);
  assert.deepEqual(ack, { success: true });
  assert.equal(cube.sent.length, 2);
});

test('decided on the fresh read: a device not heard, gone, or a read that fails: not sent', async () => {
  const { gladys, cube, start, createAll, advance } = await setup({ config: ALLOW });
  await start();
  await createAll();
  cube.states = [[WALL, { target: 20 }]];
  let ack = await command(gladys, 'thermostat', TRV.serial, 'target', 21);
  assert.match(ack.error, /not heard over the radio/);
  // The thermostat unpaired: not in the metadata of a new greeting.
  cube.devices = [WALL, WINDOW];
  cube.dropAll();
  await settle();
  cube.states = [[WALL, { target: 20 }]];
  ack = await command(gladys, 'thermostat', TRV.serial, 'target', 21);
  assert.match(ack.error, /no longer paired/);
  // The Cube does not answer l:: nothing is sent, the error says the read failed.
  cube.ignoreList = true;
  cube.states = [[TRV, { target: 20 }]];
  const pending = command(gladys, 'wall', WALL.serial, 'target', 21);
  await advance(3 * SECOND);
  ack = await pending;
  assert.match(ack.error, /could not be read just before acting \(no answer in time\)/);
  assert.equal(cube.sent.length, 0);
});

test('the Cube discards the command (S result 1): said, nothing claimed', async () => {
  const cube = createFakeCube();
  cube.sResult = 1;
  cube.dutyCycle = 100;
  cube.freeSlots = 0;
  const { gladys, start, createAll, wait } = await setup({ cube, config: ALLOW });
  await start();
  await createAll();
  const ack = await command(gladys, 'thermostat', TRV.serial, 'target', 21);
  assert.equal(ack.success, false);
  assert.match(ack.error, /discarded the command: its radio budget/);
  assert.equal(cube.sent.length, 1);
  await wait(READ_AFTER_COMMAND_MS);
  assert.equal(last(gladys, C('duty_cycle')), 100);
  assert.equal(last(gladys, C('free_slots')), 0);
  assert.match(status(gladys).message.fr, /budget radio du Cube est à 100 %/);
});

test('no answer to s: in time: "sent, without confirmation" at 4.3 s; too slow: not sent', async () => {
  const { gladys, cube, start, createAll, advance, clock } = await setup({ config: ALLOW });
  await start();
  await createAll();
  cube.ignoreSend = true;
  const pending = command(gladys, 'thermostat', TRV.serial, 'target', 21);
  await settle();
  assert.equal(cube.sent.length, 1);
  await advance(4300);
  const ack = await pending;
  assert.match(ack.error, /sent to the Cube, without confirmation/);
  // The exchange timed out at 2 s: the connection was dropped; the next
  // command gets a new one.
  assert.equal(cube.connections[0].open, false);
  cube.ignoreSend = false;
  const ack2 = await command(gladys, 'thermostat', TRV.serial, 'target', 22);
  assert.deepEqual(ack2, { success: true });
  assert.equal(cube.connections.length, 2);
  assert.equal(cube.sent.length, 2);
  // A command whose budget ran out before the read: nothing read, nothing sent.
  cube.ignoreSend = false;
  const slow = createFakeCube();
  const other = await setup({ cube: slow, config: ALLOW });
  await other.start();
  await other.createAll();
  // The budget is on the monotonic clock: 2.5 s pass between arrival and read.
  const original = other.app.monotonic;
  let calls = 0;
  other.app.monotonic = () => original() + (calls++ > 0 ? 2500 : 0);
  const ack3 = await command(other.gladys, 'thermostat', TRV.serial, 'target', 21);
  assert.match(ack3.error, /too slow/);
  assert.equal(listsOf(slow), 0);
  assert.equal(clock.now >= 0, true);
});

test('a stop (mode off) goes first and drops a connection that no longer answers', async () => {
  const { gladys, cube, start, createAll, advance, app } = await setup({ config: ALLOW });
  await start();
  await createAll();
  // A read in flight that the Cube does not answer.
  cube.ignoreList = true;
  await advance(MINUTE);
  assert.equal(listsOf(cube), 1);
  await advance(TIMEOUTS.STALL);
  assert.equal(cube.connections.length, 1);
  cube.ignoreList = false;
  // Two commands queued: a setpoint, then a stop: the stop is served first,
  // on a new connection (the stalled one is dropped).
  const setpoint = command(gladys, 'thermostat', TRV.serial, 'target', 21);
  const stop = command(gladys, 'thermostat', TRV.serial, 'mode', 0);
  await settle(20);
  assert.equal(cube.connections.length, 2, 'a new connection for the stop');
  assert.equal(cube.connections[0].open, false);
  const ackStop = await stop;
  assert.deepEqual(ackStop, { success: true });
  assert.equal(cube.sent[0].length > 2, true);
  assert.equal([...Buffer.from(cube.sent[0].slice(2), 'base64')][10], 0x49, 'the stop first');
  // The setpoint of the same room, not written yet: cancelled by the stop.
  const ackSet = await setpoint;
  assert.equal(ackSet.success, false);
  assert.match(ackSet.error, /Cancelled: a stop was asked/);
  assert.equal(cube.sent.length, 1);
  assert.equal(app.commands.length, 0);
});

test('a permission taken away applies at once; the configuration changed: not sent', async () => {
  const { gladys, cube, start, createAll, app } = await setup({ config: ALLOW });
  await start();
  await createAll();
  const restart = app.start(CONFIG);
  const ack = await command(gladys, 'thermostat', TRV.serial, 'target', 21);
  assert.match(ack.error, /Allow the setpoint commands/);
  await restart;
  assert.equal(cube.sent.length, 0);
});

test('commands with keep_connection off: a connection for the command, closed after', async () => {
  const { gladys, cube, start, createAll, wait } = await setup({
    config: { ...ALLOW, keep_connection: false },
  });
  await start();
  await createAll();
  const ack = await command(gladys, 'thermostat', TRV.serial, 'target', 21);
  assert.deepEqual(ack, { success: true });
  await settle();
  assert.equal(cube.connections.length, 2);
  assert.equal(cube.connections[1].open, false, 'closed once the S answer came');
  assert.ok(cube.connections[1].lines.includes('q:'));
  assert.equal(cube.peak, 1);
  await wait(READ_AFTER_COMMAND_MS);
  assert.equal(cube.connections.length, 3);
});

// --- Buttons and Discovery ------------------------------------------------------------

test('"Test the connection": a read when due, otherwise the last read; Discovery never reads', async () => {
  const { gladys, cube, start, wait } = await setup();
  await start();
  let answer = await gladys.fake.action('test_connection', {});
  assert.equal(answer.success, true);
  assert.match(answer.data.message.fr, /lu il y a moins d’une minute/);
  assert.match(answer.data.message.fr, /Prochaine lecture dans 1 min/);
  assert.equal(listsOf(cube), 0);
  await wait(MINUTE);
  assert.equal(listsOf(cube), 1);
  await wait(MINUTE);
  answer = await gladys.fake.action('test_connection', {});
  assert.match(answer.data.message.fr, /lu il y a moins d’une minute/);
  assert.equal(listsOf(cube), 2, 'no read: the loop just read');
  await wait(MINUTE - SECOND);
  assert.equal(listsOf(cube), 2);
  // The loop timer fires at the minute: the button at 59 s does not read.
  answer = await gladys.fake.action('test_connection', {});
  assert.equal(listsOf(cube), 2);
  assert.match(answer.data.message.fr, /Prochaine lecture dans 1 s/);
  await wait(SECOND);
  assert.equal(listsOf(cube), 3);
  await gladys.fake.scanRequest();
  assert.equal(listsOf(cube), 3);
  assert.equal(gladys.fake.discoveredDevices.length, 4);
  // Unreachable: the button, when due, reads and reports.
  cube.silent = true;
  cube.dropAll();
  await wait(MINUTE + TIMEOUTS.CONNECT);
  assert.equal(status(gladys).connected, false);
  await wait(MINUTE);
  answer = await gladys.fake.action('test_connection', {});
  assert.match(
    answer.data.message.fr,
    /Le Cube n’a pas pu être lu|tarde à répondre|moins d’une minute/,
  );
});

test('"Test the connection" reads now after a failure, once the interval has passed', async () => {
  const cube = createFakeCube();
  cube.refuse = true;
  const { gladys, start, wait, delays } = await setup({ cube });
  await start();
  await wait(MINUTE);
  assert.match(status(gladys).message.fr, /Nouvel essai dans 2 min/);
  cube.refuse = false;
  // 30 s after the last attempt: the interval is respected.
  await wait(30 * SECOND);
  let answer = await gladys.fake.action('test_connection', {});
  assert.match(answer.data.message.fr, /Nouvel essai dans 2 min/);
  assert.equal(cube.connections.length, 0);
  await wait(30 * SECOND);
  answer = await gladys.fake.action('test_connection', {});
  assert.equal(cube.connections.length, 1, 'read now, the retry pause not waited for');
  assert.match(
    answer.data.message.en,
    /MAX! Cube KEQ0523864 read \(firmware 1\.1\.3\): 1 radiator thermostat, 1 wall thermostat, 1 window contact/,
  );
  assert.match(
    answer.data.message.fr,
    /1 thermostat de radiateur, 1 thermostat mural, 1 contact de fenêtre/,
  );
  assert.equal(status(gladys).connected, true);
  assert.deepEqual(delays().map(Math.round), [MINUTE], 'the loop goes on from there');
});

test('a device republished keeps every feature of the created one and its shape', async () => {
  const gladys0 = createFakeGladys({ selector: 'maxcube' });
  const created = {
    external_id: ext('thermostat', TRV.serial),
    name: 'Old',
    features: [
      {
        external_id: T('target'),
        name: 'Setpoint',
        category: 'thermostat',
        type: 'target-temperature',
        unit: 'celsius',
        min: 5,
        max: 28,
        read_only: false,
        has_feedback: true,
        keep_history: true,
      },
      {
        external_id: T('old_feature'),
        name: 'Old',
        category: 'unknown',
        type: 'decimal',
        min: 0,
        max: 1,
        read_only: true,
      },
    ],
  };
  const { gladys, start } = await setup({ devices: [created] });
  await start();
  const trv = gladys.fake.discoveredDevices.find((d) => d.external_id === created.external_id);
  const target = trv.features.find((f) => f.external_id === T('target'));
  assert.equal(target.min, 5, 'the created shape');
  assert.equal(target.max, 28);
  assert.ok(trv.features.some((f) => f.external_id === T('old_feature')));
  assert.ok(gladys0);
});

test('logs never hold what the Cube sent, only our words and kinds', async () => {
  const cube = createFakeCube();
  cube.hello = 'H:SECRET1234,097f2c,0113,00000000,477719c0,00,32,0d0c09,1404,03,0000';
  const { logger, start, wait } = await setup({ cube });
  await start();
  cube.silent = true;
  cube.dropAll();
  await wait(MINUTE + TIMEOUTS.CONNECT);
  assert.ok(!logger.lines.some((l) => /SECRET1234|H:|L:|M:/.test(l)), logger.lines.join('\n'));
  assert.ok(logger.lines.some((l) => /Using the MAX! Cube at 192.168.1.40:62910/.test(l)));
  assert.ok(
    logger.lines.some((l) => /The Cube fails: timeout/.test(l)),
    logger.lines.join('\n'),
  );
});

test('a device deleted and created again: values and badge at once; an updated one: values again', async () => {
  const { gladys, start, createAll } = await setup();
  await start();
  await createAll();
  const trv = deviceOf(gladys, 'thermostat', TRV.serial);
  await gladys.fake.deviceDeleted(trv);
  const before = gladys.fake.states.length;
  await gladys.fake.deviceCreated(trv);
  await settle();
  assert.ok(gladys.fake.states.length > before);
  const again = gladys.fake.states.length;
  await gladys.fake.deviceUpdated(trv);
  await settle();
  assert.ok(gladys.fake.states.length > again, 'published again after an update');
});
