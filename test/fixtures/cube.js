// -----------------------------------------------------------------------------
// Messages of a MAX! Cube: the examples of Bouni/max-cube-protocol (MIT) and
// encoders that build the greeting of a small installation (a radiator
// thermostat and a wall thermostat in the living room, a window contact in
// the bedroom, a push button the integration ignores).
// -----------------------------------------------------------------------------

// From H-Message.md: serial KEQ0523864, RF 097f2c, firmware 1.1.3, duty cycle 0, 50 free slots.
export const DOC_H = 'H:KEQ0523864,097f2c,0113,00000000,477719c0,00,32,0d0c09,1404,03,0000';

// From M-Message.md: 4 rooms (Bad, Buro, Wohnzimmer, Schlafzimmer), 5 thermostats plus.
export const DOC_M =
  'M:00,01,VgIEAQNCYWQK7WkCBEJ1cm8K8wADCldvaG56aW1tZXIK8wwEDFNjaGxhZnppbW1lcgr1QAUCCu1pS0VRMDM3ODA0MAZIVCBCYWQBAgrzAEtFUTAzNzk1NDQHSFQgQnVybwICCvMMS0VRMDM3OTU1NhlIVCBXb2huemltbWVyIEJhbGtvbnNlaXRlAwIK83lLRVEwMzc5NjY1GkhUIFdvaG56aW1tZXIgRmVuc3RlcnNlaXRlAwIK9UBLRVEwMzgwMTIwD0hUIFNjaGxhZnppbW1lcgQB';

// From L-Message.md: three entries, 0FDAED (auto, valve 24, 20 °C), 0FC373 and 0FC380 (20.7 and 20.6 °C).
export const DOC_L = 'L:Cw/a7QkSGBgoAMwACw/DcwkSGBgoAM8ACw/DgAkSGBgoAM4A';

// From S-Message.md: the Cube processed the command, duty cycle 0, 49 free slots.
export const DOC_S = 'S:00,0,31';
// From S-Message.md (the s command example, command 40 to 0FDAED room 1, 19 °C manual).
export const DOC_s = 's:AARAAAAAB5EAAWY=';

export const CUBE_SERIAL = 'KEQ0523864';
export const TRV = { type: 2, rf: '0AED69', serial: 'KEQ0378040', name: 'Radiator', room: 1 };
export const WALL = { type: 3, rf: '0FC380', serial: 'LEQ0794752', name: 'Wall', room: 1 };
export const WINDOW = { type: 4, rf: '0FDAED', serial: 'KEQ0839778', name: 'Window', room: 2 };
export const BUTTON = { type: 5, rf: '0F1234', serial: 'KEQ0000005', name: 'Button', room: 2 };
export const ROOMS = [
  { id: 1, name: 'Living room', rf: '0AED69' },
  { id: 2, name: 'Bedroom', rf: '0FDAED' },
];
export const DEVICES = [TRV, WALL, WINDOW, BUTTON];

const rf = (hex) => [...Buffer.from(hex, 'hex')];
const str = (text) => {
  const bytes = [...Buffer.from(text, 'utf8')];
  return [bytes.length, ...bytes];
};

/** The bytes of an M message for `rooms` and `devices`. */
export function encodeMetadata(rooms = ROOMS, devices = DEVICES) {
  const bytes = [0x56, 0x02, rooms.length];
  for (const room of rooms) bytes.push(room.id, ...str(room.name), ...rf(room.rf));
  bytes.push(devices.length);
  for (const d of devices) {
    bytes.push(d.type, ...rf(d.rf), ...Buffer.from(d.serial, 'ascii'), ...str(d.name), d.room);
  }
  bytes.push(0x01);
  return Buffer.from(bytes);
}

/** One or several M lines (the base64 cut in blocks of `block` characters). */
export function encodeM(rooms = ROOMS, devices = DEVICES, { block } = {}) {
  const text = encodeMetadata(rooms, devices).toString('base64');
  if (!block) return [`M:00,01,${text}`];
  const parts = [];
  for (let i = 0; i < text.length; i += block) parts.push(text.slice(i, i + block));
  const count = parts.length.toString(16).padStart(2, '0');
  return parts.map((part, i) => `M:${i.toString(16).padStart(2, '0')},${count},${part}`);
}

/** The C line of a device: comfort 21, eco 17, max 30.5, min 4.5 by default. */
export function encodeC(device, { comfort = 21, eco = 17, max = 30.5, min = 4.5 } = {}) {
  const bytes = [
    0x00,
    ...rf(device.rf),
    device.type,
    device.room,
    0x10,
    0x00,
    ...Buffer.from(device.serial, 'ascii'),
  ];
  if (device.type === 1 || device.type === 2 || device.type === 3) {
    bytes.push(comfort * 2, eco * 2, max * 2, min * 2, 0x07, 0x18, 0x03, 0xf4, 0x0c, 0xff, 0x00);
  }
  bytes[0] = bytes.length - 1;
  return `C:${device.rf.toLowerCase()},${Buffer.from(bytes).toString('base64')}`;
}

/**
 * One L entry. `state`: { mode (0..3), battery, link, valid, initialized,
 * valve, target, temperature (TRV: 9 bits over bytes 8-9; wall: byte 11 and
 * the top bit of byte 7), open (window) }.
 */
export function encodeEntry(device, state = {}) {
  const {
    mode = 0,
    battery = false,
    link = false,
    valid = true,
    initialized = true,
    valve = 0,
    target = 20,
    temperature,
    open = false,
  } = state;
  const bits1 = (valid ? 0x10 : 0) | (initialized ? 0x02 : 0);
  let bits2 = (battery ? 0x80 : 0) | (link ? 0x40 : 0) | 0x10 | (mode & 0x03);
  if (device.type === 4) {
    bits2 = (bits2 & ~0x03) | (open ? 0x02 : 0);
    return [6, ...rf(device.rf), 0x09, bits1, bits2];
  }
  const tenths = temperature === undefined ? 0 : Math.round(temperature * 10);
  if (device.type === 3) {
    const targetByte = Math.round(target * 2) | (tenths > 255 ? 0x80 : 0);
    return [12, ...rf(device.rf), 0x09, bits1, bits2, 4, targetByte, 0, 0, 0, tenths & 0xff];
  }
  return [
    11,
    ...rf(device.rf),
    0x09,
    bits1,
    bits2,
    valve,
    Math.round(target * 2),
    tenths >> 8,
    tenths & 0xff,
    0,
  ];
}

/** The L line of several devices: [[device, state], ...]. */
export function encodeL(list) {
  const bytes = list.flatMap(([device, state]) => encodeEntry(device, state));
  return `L:${Buffer.from(bytes).toString('base64')}`;
}

export const DEFAULT_STATES = () => [
  [TRV, { mode: 0, valve: 30, target: 20, temperature: 19.5 }],
  [WALL, { mode: 0, target: 20, temperature: 21.3 }],
  [WINDOW, { open: false }],
];
