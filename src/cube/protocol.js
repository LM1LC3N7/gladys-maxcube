// -----------------------------------------------------------------------------
// The protocol of the eQ-3 MAX! Cube on its TCP port 62910, ported from the
// Bouni/max-cube-protocol description and python-maxcube-api (both MIT, see
// THIRD_PARTY_NOTICES.md). Pure functions: a line in, plain objects out.
//
// A message is one line `X:<argument>\r\n`. The Cube greets a new connection
// with H (hello), M (metadata: rooms and devices, base64, maybe in several
// blocks), one C per device (configuration, base64) and L (the live values,
// base64). `l:` asks for L again; `s:<base64>` sends a radio command and is
// answered by `S:<duty cycle>,<result>,<free slots>`; `q:` closes.
//
// Every index into a decoded buffer is checked: a short or hostile message
// throws a ProtocolError, never reads past the end, never loops on a length.
// Nothing here ever builds the reset (`a:`), the factory commands or the
// pairing commands: only `l:`, `s:` (temperature and mode) and `q:` exist.
// -----------------------------------------------------------------------------

import { LIMITS } from '../constants.js';

export class ProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProtocolError';
  }
}

/** The device types of the M message (and of the C message). */
export const DEVICE_TYPES = Object.freeze({
  CUBE: 0,
  THERMOSTAT: 1,
  THERMOSTAT_PLUS: 2,
  WALL_THERMOSTAT: 3,
  SHUTTER_CONTACT: 4,
  PUSH_BUTTON: 5,
});

/** The modes of a thermostat (two bits of the L flags and of the s command). */
export const MODES = Object.freeze({ AUTO: 0, MANUAL: 1, VACATION: 2, BOOST: 3 });
export const MODE_NAMES = Object.freeze(['auto', 'manual', 'vacation', 'boost']);

/** The setpoints that mean "valve closed" and "valve open" on a MAX! thermostat. */
export const OFF_TEMPERATURE = 4.5;
export const ON_TEMPERATURE = 30.5;

export const isThermostat = (type) =>
  type === DEVICE_TYPES.THERMOSTAT || type === DEVICE_TYPES.THERMOSTAT_PLUS;
export const isWallThermostat = (type) => type === DEVICE_TYPES.WALL_THERMOSTAT;
export const isShutterContact = (type) => type === DEVICE_TYPES.SHUTTER_CONTACT;

/** `X:argument` -> { type, arg }, or null for anything else. */
export function parseLine(line) {
  if (typeof line !== 'string' || line.length < 2 || line[1] !== ':') return null;
  const type = line[0];
  if (!/^[A-Za-z]$/.test(type)) return null;
  return { type, arg: line.slice(2) };
}

const hex = (text, digits) =>
  typeof text === 'string' && text.length === digits && /^[0-9a-fA-F]+$/.test(text)
    ? parseInt(text, 16)
    : undefined;
const rfAddressOf = (bytes) =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join('');
const base64 = (text) => {
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
    throw new ProtocolError('bad base64');
  }
  return Buffer.from(text, 'base64');
};

/** Control characters and the replacement character, kept out of the names. */
const UNWANTED = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}${String.fromCharCode(0xfffd)}]`,
  'g',
);

/** A name of the Cube: UTF-8, control characters out, bounded. */
export function cleanName(bytes) {
  return Buffer.from(bytes)
    .toString('utf8')
    .replace(UNWANTED, '')
    .trim()
    .slice(0, LIMITS.NAME_CHARS);
}

/** The firmware of the H message, `0113` -> `1.1.3`. */
export function firmwareOf(text) {
  if (typeof text !== 'string' || !/^[0-9a-fA-F]{4}$/.test(text)) return undefined;
  return `${parseInt(text.slice(0, 2), 16)}.${parseInt(text[2], 16)}.${parseInt(text[3], 16)}`;
}

/**
 * H:KEQ0523864,097f2c,0113,00000000,477719c0,00,32,0d0c09,1404,03,0000
 * -> { serial, rfAddress, firmware, dutyCycle, freeSlots }
 */
export function parseH(arg) {
  const fields = String(arg).split(',');
  if (fields.length < 7) throw new ProtocolError('short H message');
  const serial = fields[0];
  if (!/^[A-Za-z0-9]{1,16}$/.test(serial)) throw new ProtocolError('bad serial in H');
  const rfAddress = hex(fields[1], 6);
  if (rfAddress === undefined) throw new ProtocolError('bad RF address in H');
  return {
    serial: serial.toUpperCase(),
    rfAddress: fields[1].toUpperCase(),
    firmware: firmwareOf(fields[2]),
    dutyCycle: hex(fields[5], 2),
    freeSlots: hex(fields[6], 2),
  };
}

/**
 * One M line: `M:<index>,<count>,<base64>` -> { index, count, data }. The
 * data of every block is joined before decoding (`decodeMetadata`).
 */
export function parseMPart(arg) {
  const fields = String(arg).split(',');
  if (fields.length !== 3) throw new ProtocolError('bad M message');
  const index = hex(fields[0], 2);
  const count = hex(fields[1], 2);
  if (index === undefined || count === undefined || count < 1 || index >= count) {
    throw new ProtocolError('bad M index');
  }
  if (count > LIMITS.METADATA_PARTS) throw new ProtocolError('too many M blocks');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(fields[2])) throw new ProtocolError('bad base64');
  return { index, count, data: fields[2] };
}

/**
 * The bytes of the M blocks, in order. The Cube cuts the base64 text itself
 * or the bytes: a block padded with "=" before the last one is a whole
 * number of bytes and is decoded on its own; otherwise the texts are joined
 * (a block without padding is also a whole number of base64 groups, or a
 * cut in the text).
 */
export function decodeMetadata(parts) {
  const padded = parts.some((part, i) => i < parts.length - 1 && part.includes('='));
  if (!padded) return base64(parts.join(''));
  return Buffer.concat(parts.map((part) => base64(part)));
}

class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.pos = 0;
  }

  need(n) {
    if (this.pos + n > this.bytes.length) throw new ProtocolError('short message');
  }

  byte() {
    this.need(1);
    return this.bytes[this.pos++];
  }

  take(n) {
    this.need(n);
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}

/**
 * The decoded metadata -> { rooms: [{ id, name, rfAddress }], devices:
 * [{ type, rfAddress, serial, name, roomId }] }. Only the device types this
 * integration knows are kept (push buttons are listed, never published).
 */
export function parseMetadata(bytes) {
  const reader = new Reader(bytes);
  reader.take(2); // 'V', a version byte
  const roomCount = reader.byte();
  if (roomCount > LIMITS.ROOMS) throw new ProtocolError('too many rooms');
  const rooms = [];
  for (let i = 0; i < roomCount; i += 1) {
    const id = reader.byte();
    const name = cleanName(reader.take(reader.byte()));
    const rfAddress = rfAddressOf(reader.take(3));
    rooms.push({ id, name, rfAddress });
  }
  const deviceCount = reader.byte();
  if (deviceCount > LIMITS.DEVICES) throw new ProtocolError('too many devices');
  const devices = [];
  for (let i = 0; i < deviceCount; i += 1) {
    const type = reader.byte();
    const rfAddress = rfAddressOf(reader.take(3));
    const serial = cleanName(reader.take(10)).toUpperCase();
    const name = cleanName(reader.take(reader.byte()));
    const roomId = reader.byte();
    devices.push({ type, rfAddress, serial, name, roomId });
  }
  return { rooms, devices };
}

/**
 * C:<rf>,<base64> -> { rfAddress, type, roomId, serial, comfort, eco, max,
 * min } (the temperatures for the thermostats only, undefined otherwise).
 */
export function parseC(arg) {
  const fields = String(arg).split(',');
  if (fields.length !== 2) throw new ProtocolError('bad C message');
  const data = base64(fields[1]);
  if (data.length < 18) throw new ProtocolError('short C message');
  const rfAddress = rfAddressOf(data.subarray(1, 4));
  if (rfAddress !== fields[0].toUpperCase()) throw new ProtocolError('C address mismatch');
  const type = data[4];
  const config = {
    rfAddress,
    type,
    roomId: data[5],
    serial: cleanName(data.subarray(8, 18)).toUpperCase(),
  };
  if ((isThermostat(type) || isWallThermostat(type)) && data.length >= 22) {
    config.comfort = data[18] / 2;
    config.eco = data[19] / 2;
    config.max = data[20] / 2;
    config.min = data[21] / 2;
  }
  return config;
}

/** The two flag bytes of an L entry, decoded. */
export function parseFlags(bits1, bits2) {
  return {
    valid: (bits1 & 0x10) !== 0,
    error: (bits1 & 0x08) !== 0,
    answer: (bits1 & 0x04) === 0,
    initialized: (bits1 & 0x02) !== 0,
    batteryLow: (bits2 & 0x80) !== 0,
    linkError: (bits2 & 0x40) !== 0,
    panelLocked: (bits2 & 0x20) !== 0,
    gatewayKnown: (bits2 & 0x10) !== 0,
    dst: (bits2 & 0x08) !== 0,
    mode: bits2 & 0x03,
  };
}

/**
 * L:<base64> -> entries [{ rfAddress, length, flags, valve, target,
 * temperature, wallTemperature, open }]. The meaning of the bytes depends on
 * the device: `deviceState` applies the type known from the metadata.
 */
export function parseL(arg) {
  const data = base64(String(arg));
  const entries = [];
  let pos = 0;
  while (pos < data.length) {
    const length = data[pos];
    if (length < 6 || pos + 1 + length > data.length) throw new ProtocolError('bad L entry');
    const entry = data.subarray(pos + 1, pos + 1 + length);
    pos += 1 + length;
    if (entries.length >= LIMITS.LIST_ENTRIES) throw new ProtocolError('too many L entries');
    const item = {
      rfAddress: rfAddressOf(entry.subarray(0, 3)),
      length,
      flags: parseFlags(entry[4], entry[5]),
    };
    if (length >= 11) {
      item.valve = entry[6];
      item.target = (entry[7] & 0x7f) / 2;
      // The room temperature of a radiator thermostat, in auto and manual
      // modes only (the bytes hold the end of a vacation otherwise); 0 is
      // "not measured". Nine bits: the low bit of byte 8 and byte 9.
      item.temperature = ((entry[8] & 0x01) * 256 + entry[9]) / 10;
    }
    if (length >= 12) {
      // A wall thermostat: nine bits, the top bit of byte 7 and byte 11.
      item.wallTemperature = (((entry[7] & 0x80) << 1) + entry[11]) / 10;
    }
    item.open = (entry[5] & 0x03) !== 0;
    entries.push(item);
  }
  return entries;
}

const plausible = (t) => t > 0 && t < 60;

/**
 * The state of a device of a known type from its L entry:
 * { mode, batteryLow, linkError, valid, target?, valve?, temperature?, open? }.
 */
export function deviceState(entry, type) {
  const base = {
    valid: entry.flags.valid,
    initialized: entry.flags.initialized,
    batteryLow: entry.flags.batteryLow,
    linkError: entry.flags.linkError,
  };
  if (isThermostat(type)) {
    if (entry.length < 11) return undefined;
    const mode = entry.flags.mode;
    const measured = mode === MODES.AUTO || mode === MODES.MANUAL;
    return {
      ...base,
      mode,
      target: entry.target,
      valve: entry.valve <= 100 ? entry.valve : undefined,
      temperature: measured && plausible(entry.temperature) ? entry.temperature : undefined,
    };
  }
  if (isWallThermostat(type)) {
    if (entry.length < 12) return undefined;
    return {
      ...base,
      mode: entry.flags.mode,
      target: entry.target,
      temperature: plausible(entry.wallTemperature) ? entry.wallTemperature : undefined,
    };
  }
  if (isShutterContact(type)) {
    return { ...base, open: entry.open };
  }
  return undefined;
}

/** S:<duty cycle>,<result>,<free slots> -> { dutyCycle, result, freeSlots }. */
export function parseS(arg) {
  const fields = String(arg).split(',');
  if (fields.length < 3) throw new ProtocolError('bad S message');
  const dutyCycle = hex(fields[0], 2);
  const freeSlots = hex(fields[2], 2);
  if (dutyCycle === undefined || freeSlots === undefined || !/^[01]$/.test(fields[1])) {
    throw new ProtocolError('bad S message');
  }
  return { dutyCycle, result: Number(fields[1]), freeSlots };
}

/** A temperature a command may carry: 0 (auto: follow the programme) or 4.5 to 30.5 by half degrees. */
export const isCommandTemperature = (t) =>
  typeof t === 'number' &&
  Number.isFinite(t) &&
  Math.abs(t * 2 - Math.round(t * 2)) < 1e-9 &&
  (t === 0 || (t >= OFF_TEMPERATURE && t <= ON_TEMPERATURE));

/**
 * The `s:` command 40 (temperature and mode), as python-maxcube-api builds
 * it: `00 <rf flag> 40 000000 <rf address> <room> <mode << 6 | temp * 2>`.
 * The rf flag addresses the room (04) when the device has one, as the MAX!
 * software does (every thermostat of the room follows); a device without a
 * room (00) is addressed alone. Only auto (temperature 0: back to the
 * programme, or a temperature until the next switch point) and manual.
 */
export function buildTemperatureCommand({ rfAddress, roomId, temperature, mode }) {
  if (typeof rfAddress !== 'string' || !/^[0-9A-F]{6}$/.test(rfAddress)) {
    throw new ProtocolError('bad RF address');
  }
  if (!Number.isInteger(roomId) || roomId < 0 || roomId > 255) throw new ProtocolError('bad room');
  if (mode !== MODES.AUTO && mode !== MODES.MANUAL) throw new ProtocolError('bad mode');
  if (!isCommandTemperature(temperature) || (mode === MODES.MANUAL && temperature === 0)) {
    throw new ProtocolError('bad temperature');
  }
  const bytes = Buffer.from([
    0x00,
    roomId > 0 ? 0x04 : 0x00,
    0x40,
    0x00,
    0x00,
    0x00,
    ...Buffer.from(rfAddress, 'hex'),
    roomId,
    (mode << 6) | Math.round(temperature * 2),
  ]);
  return bytes.toString('base64');
}
