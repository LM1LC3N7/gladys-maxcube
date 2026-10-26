// -----------------------------------------------------------------------------
// The protocol (src/cube/protocol.js) on the examples of the documentation
// and on hostile messages: every index is checked, nothing loops.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS } from '../src/constants.js';
import {
  MODES,
  ProtocolError,
  buildTemperatureCommand,
  decodeMetadata,
  deviceState,
  firmwareOf,
  isCommandTemperature,
  parseC,
  parseH,
  parseL,
  parseLine,
  parseMPart,
  parseMetadata,
  parseS,
} from '../src/cube/protocol.js';
import {
  DOC_H,
  DOC_L,
  DOC_M,
  DOC_S,
  DOC_s,
  TRV,
  WALL,
  WINDOW,
  encodeC,
  encodeL,
  encodeM,
  encodeMetadata,
} from './fixtures/cube.js';

const arg = (line) => parseLine(line).arg;

test('parseLine: one letter, a colon, the argument', () => {
  assert.deepEqual(parseLine('H:abc'), { type: 'H', arg: 'abc' });
  assert.deepEqual(parseLine('L:'), { type: 'L', arg: '' });
  assert.equal(parseLine('hello'), null);
  assert.equal(parseLine(''), null);
  assert.equal(parseLine('1:x'), null);
});

test('H: the serial, the RF address, the firmware, the duty cycle and the free slots', () => {
  assert.deepEqual(parseH(arg(DOC_H)), {
    serial: 'KEQ0523864',
    rfAddress: '097F2C',
    firmware: '1.1.3',
    dutyCycle: 0,
    freeSlots: 50,
  });
  assert.equal(firmwareOf('0113'), '1.1.3');
  assert.equal(firmwareOf('zz'), undefined);
  assert.throws(() => parseH('KEQ0523864,097f2c'), ProtocolError);
  assert.throws(() => parseH('../../x,097f2c,0113,0,0,00,32'), ProtocolError);
});

test('M: the rooms and devices of the documentation example', () => {
  const part = parseMPart(arg(DOC_M));
  assert.equal(part.index, 0);
  assert.equal(part.count, 1);
  const meta = parseMetadata(decodeMetadata([part.data]));
  assert.deepEqual(
    meta.rooms.map((r) => [r.id, r.name, r.rfAddress]),
    [
      [1, 'Bad', '0AED69'],
      [2, 'Buro', '0AF300'],
      [3, 'Wohnzimmer', '0AF30C'],
      [4, 'Schlafzimmer', '0AF540'],
    ],
  );
  assert.equal(meta.devices.length, 5);
  assert.deepEqual(meta.devices[0], {
    type: 2,
    rfAddress: '0AED69',
    serial: 'KEQ0378040',
    name: 'HT Bad',
    roomId: 1,
  });
  assert.deepEqual(meta.devices[4], {
    type: 2,
    rfAddress: '0AF540',
    serial: 'KEQ0380120',
    name: 'HT Schlafzimmer',
    roomId: 4,
  });
});

test('M: several blocks, cut in the base64 text or in the bytes, give the same metadata', () => {
  const whole = parseMetadata(encodeMetadata());
  for (const block of [20, 33, 100]) {
    const parts = encodeM(undefined, undefined, { block }).map((line) => parseMPart(arg(line)));
    const meta = parseMetadata(decodeMetadata(parts.map((p) => p.data)));
    assert.deepEqual(meta, whole, `blocks of ${block}`);
  }
  // Cut in the bytes: each block padded on its own.
  const bytes = encodeMetadata();
  const chunks = [bytes.subarray(0, 10), bytes.subarray(10, 25), bytes.subarray(25)];
  const meta = parseMetadata(decodeMetadata(chunks.map((c) => c.toString('base64'))));
  assert.deepEqual(meta, whole);
  assert.equal(meta.devices[3].type, 5, 'the push button is listed');
  assert.throws(() => parseMPart('00,00,AAAA'), ProtocolError, 'count 0');
  assert.throws(() => parseMPart('02,02,AAAA'), ProtocolError, 'index past the count');
  assert.throws(() => parseMPart('00,ff,AAAA'), ProtocolError, 'too many blocks');
  assert.throws(() => parseMPart('00,01,AA$A'), ProtocolError, 'not base64');
});

test('M: a short or hostile metadata throws, never reads past the end', () => {
  const bytes = encodeMetadata();
  for (let cut = 1; cut < bytes.length - 1; cut += 1) {
    assert.throws(() => parseMetadata(bytes.subarray(0, cut)), ProtocolError, `cut at ${cut}`);
  }
  assert.throws(() => parseMetadata(Buffer.from([0x56, 0x02, 0xff])), ProtocolError, 'rooms');
  const many = Buffer.from([0x56, 0x02, 0x00, LIMITS.DEVICES + 1]);
  assert.throws(() => parseMetadata(many), ProtocolError, 'devices');
  // A name with control characters and a long one: cleaned and bounded.
  const dirty = encodeMetadata(
    [{ id: 1, name: 'Bad\u0000\u001f\r\n room', rf: '0AED69' }],
    [{ ...TRV, name: 'x'.repeat(200) }],
  );
  const meta = parseMetadata(dirty);
  assert.equal(meta.rooms[0].name, 'Bad room');
  assert.equal(meta.devices[0].name.length, LIMITS.NAME_CHARS);
});

test('C: the comfort, eco, max and min temperatures of a thermostat', () => {
  const config = parseC(arg(encodeC(TRV, { comfort: 21.5, eco: 16, max: 28, min: 8 })));
  assert.deepEqual(config, {
    rfAddress: '0AED69',
    type: 2,
    roomId: 1,
    serial: 'KEQ0378040',
    comfort: 21.5,
    eco: 16,
    max: 28,
    min: 8,
  });
  const wall = parseC(arg(encodeC(WALL)));
  assert.equal(wall.comfort, 21);
  assert.equal(wall.max, 30.5);
  const window = parseC(arg(encodeC(WINDOW)));
  assert.equal(window.type, 4);
  assert.equal(window.comfort, undefined);
  assert.throws(() => parseC('0aed69,AAAA'), ProtocolError, 'short');
  assert.throws(
    () => parseC(`0fc380,${arg(encodeC(TRV)).split(',')[1]}`),
    ProtocolError,
    'mismatch',
  );
  assert.throws(() => parseC('x'), ProtocolError);
});

test('L: the documentation example and the flags', () => {
  const entries = parseL(arg(DOC_L));
  assert.equal(entries.length, 3);
  const [first, , third] = entries;
  assert.equal(first.rfAddress, '0FDAED');
  assert.equal(first.length, 11);
  assert.equal(first.flags.valid, true);
  assert.equal(first.flags.initialized, true);
  assert.equal(first.flags.mode, MODES.AUTO);
  assert.equal(first.flags.batteryLow, false);
  assert.equal(first.valve, 24);
  assert.equal(first.target, 20);
  assert.equal(third.rfAddress, '0FC380');
  assert.equal(third.temperature, 20.6);
  const state = deviceState(third, 1);
  assert.deepEqual(state, {
    valid: true,
    initialized: true,
    batteryLow: false,
    linkError: false,
    mode: MODES.AUTO,
    target: 20,
    valve: 24,
    temperature: 20.6,
  });
});

test('L: the state of each device type from our encoder', () => {
  const line = encodeL([
    [TRV, { mode: MODES.MANUAL, valve: 100, target: 4.5, temperature: 25.6, battery: true }],
    [WALL, { mode: MODES.BOOST, target: 22.5, temperature: 30.2, link: true }],
    [WINDOW, { open: true }],
  ]);
  const [trv, wall, window] = parseL(arg(line));
  assert.deepEqual(deviceState(trv, 2), {
    valid: true,
    initialized: true,
    batteryLow: true,
    linkError: false,
    mode: MODES.MANUAL,
    target: 4.5,
    valve: 100,
    temperature: 25.6,
  });
  assert.deepEqual(deviceState(wall, 3), {
    valid: true,
    initialized: true,
    batteryLow: false,
    linkError: true,
    mode: MODES.BOOST,
    target: 22.5,
    temperature: 30.2,
  });
  assert.deepEqual(deviceState(window, 4), {
    valid: true,
    initialized: true,
    batteryLow: false,
    linkError: false,
    open: true,
  });
  // A radiator thermostat on vacation or boost: the bytes hold a date, not a temperature.
  const [vacation] = parseL(arg(encodeL([[TRV, { mode: MODES.VACATION, temperature: 21 }]])));
  assert.equal(deviceState(vacation, 1).temperature, undefined);
  // A temperature of 0 is "not measured".
  const [cold] = parseL(arg(encodeL([[TRV, { mode: MODES.AUTO }]])));
  assert.equal(deviceState(cold, 1).temperature, undefined);
  // A type the entry is too short for: no state.
  assert.equal(deviceState(window, 1), undefined);
  assert.equal(deviceState(trv, 3), undefined);
  assert.equal(deviceState(trv, 5), undefined);
});

test('L: a truncated or hostile list throws, an empty one is empty', () => {
  assert.deepEqual(parseL(''), []);
  assert.throws(() => parseL(Buffer.from([11, 1, 2, 3]).toString('base64')), ProtocolError);
  // An entry too short for any device is skipped, the next one read.
  const short = Buffer.concat([
    Buffer.from([3, 1, 2, 3]),
    Buffer.from(encodeL([[TRV, {}]]).slice(2), 'base64'),
  ]);
  assert.deepEqual(
    parseL(short.toString('base64')).map((e) => e.rfAddress),
    ['0AED69'],
  );
  assert.throws(() => parseL('not base64!'), ProtocolError);
  const many = Buffer.alloc((LIMITS.LIST_ENTRIES + 1) * 7, 6);
  for (let i = 0; i < many.length; i += 7) many[i] = 6;
  assert.throws(() => parseL(many.toString('base64')), ProtocolError, 'too many');
});

test('S: duty cycle, result and free slots', () => {
  assert.deepEqual(parseS(arg(DOC_S)), { dutyCycle: 0, result: 0, freeSlots: 49 });
  assert.deepEqual(parseS('64,1,00'), { dutyCycle: 100, result: 1, freeSlots: 0 });
  assert.throws(() => parseS('00,2,31'), ProtocolError);
  assert.throws(() => parseS('00,0'), ProtocolError);
});

test('the s command of the documentation: command 40, room 1, 19 °C manual', () => {
  const base64 = buildTemperatureCommand({
    rfAddress: '0FDAED',
    roomId: 1,
    temperature: 19,
    mode: MODES.MANUAL,
  });
  // Our fixture encodes the "RF address to" as the device, the example left it empty.
  const bytes = Buffer.from(base64, 'base64');
  assert.deepEqual([...bytes.subarray(0, 6)], [0x00, 0x04, 0x40, 0x00, 0x00, 0x00]);
  assert.deepEqual([...bytes.subarray(6)], [0x0f, 0xda, 0xed, 0x01, 0x66]);
  assert.equal(Buffer.from(DOC_s.slice(2), 'base64')[10], 0x66, 'the same last byte');
  // Auto back to the programme: temperature 0, mode 0; no room: rf flag 00.
  const auto = Buffer.from(
    buildTemperatureCommand({ rfAddress: '0AED69', roomId: 0, temperature: 0, mode: MODES.AUTO }),
    'base64',
  );
  assert.deepEqual([...auto], [0x00, 0x00, 0x40, 0x00, 0x00, 0x00, 0x0a, 0xed, 0x69, 0x00, 0x00]);
  // Off: manual 4.5 °C.
  const off = Buffer.from(
    buildTemperatureCommand({
      rfAddress: '0AED69',
      roomId: 1,
      temperature: 4.5,
      mode: MODES.MANUAL,
    }),
    'base64',
  );
  assert.equal(off[10], 0x49);
});

test('the s command refuses what the protocol cannot carry', () => {
  const ok = { rfAddress: '0AED69', roomId: 1, temperature: 20, mode: MODES.MANUAL };
  assert.throws(() => buildTemperatureCommand({ ...ok, mode: MODES.VACATION }), ProtocolError);
  assert.throws(() => buildTemperatureCommand({ ...ok, mode: MODES.BOOST }), ProtocolError);
  assert.throws(() => buildTemperatureCommand({ ...ok, temperature: 20.3 }), ProtocolError);
  assert.throws(() => buildTemperatureCommand({ ...ok, temperature: 31 }), ProtocolError);
  assert.throws(
    () => buildTemperatureCommand({ ...ok, temperature: 0 }),
    ProtocolError,
    'manual 0',
  );
  assert.throws(() => buildTemperatureCommand({ ...ok, temperature: '20' }), ProtocolError);
  assert.throws(() => buildTemperatureCommand({ ...ok, rfAddress: '0aed69' }), ProtocolError);
  assert.throws(() => buildTemperatureCommand({ ...ok, roomId: 256 }), ProtocolError);
  assert.equal(isCommandTemperature(4.5), true);
  assert.equal(isCommandTemperature(30.5), true);
  assert.equal(isCommandTemperature(4), false);
  assert.equal(isCommandTemperature(NaN), false);
  assert.equal(isCommandTemperature(0), true);
});
