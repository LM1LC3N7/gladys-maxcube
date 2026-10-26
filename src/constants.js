// -----------------------------------------------------------------------------
// Keys, limits and timings. The manifest keys, the external id shapes and the
// feature keys are stored in user devices and scenes: never rename them
// (test/manifest.test.js ties them to the manifest).
// -----------------------------------------------------------------------------

export const ACTIONS = Object.freeze({
  TEST: 'test_connection',
});

/** The external id types: `ext:<selector>:<type>:<serial number>`. */
export const KINDS = Object.freeze({
  /** The Cube itself: radio duty cycle, free command slots. */
  CUBE: 'cube',
  /** A radiator thermostat (MAX! types 1 and 2). */
  THERMOSTAT: 'thermostat',
  /** A wall-mounted thermostat (MAX! type 3). */
  WALL: 'wall',
  /** A window (shutter) contact (MAX! type 4). */
  WINDOW: 'window',
});

/** A MAX! serial number: 10 characters, letters and digits (KEQ0378040, LEQ0794752...). */
export const SERIAL = /^[A-Z0-9]{10}$/;

export const CUBE_FEATURES = Object.freeze({
  DUTY_CYCLE: 'duty_cycle',
  FREE_SLOTS: 'free_slots',
});

export const THERMOSTAT_FEATURES = Object.freeze({
  TEMPERATURE: 'temperature',
  TARGET: 'target',
  MODE: 'mode',
  MAX_MODE: 'max_mode',
  OPERATING: 'operating',
  VALVE: 'valve',
  BATTERY_LOW: 'battery_low',
  LINK_ERROR: 'link_error',
});

export const WINDOW_FEATURES = Object.freeze({
  CONTACT: 'contact',
  BATTERY_LOW: 'battery_low',
  LINK_ERROR: 'link_error',
});

/**
 * The setpoint a command may set: 5 to 30 °C by half degrees (the range of
 * the MAX! thermostats; 4.5 means "off" and 30.5 "on", both out of reach of
 * the setpoint command), narrowed to the bounds the Cube gives for the
 * device. A value outside is refused, never clamped.
 */
export const SETPOINT = Object.freeze({ MIN: 5, MAX: 30, STEP: 0.5 });

/** The TCP port of the Cube (the only one). */
export const DEFAULT_PORT = 62910;

export const TIMEOUTS = Object.freeze({
  /** The TCP connection, then the greeting of the Cube (H, M, C..., L). */
  CONNECT: 3_000,
  /** The answer of the Cube to `l:` (python-maxcube-api waits 3 s). */
  LIST: 3_000,
  /** The answer of the Cube to `s:` (python-maxcube-api waits 2 s). */
  SEND: 2_000,
  /** An exchange in flight for longer than this is stalled: a stop may drop the connection. */
  STALL: 2_500,
});

export const LIMITS = Object.freeze({
  /** One line of the Cube (an M block holds 1,900 bytes, 2.6 KB in base64). */
  LINE_BYTES: 16 * 1024,
  /** The greeting of the Cube, all lines together (50 devices: a few KB). */
  GREETING_BYTES: 256 * 1024,
  /** Lines of a greeting (H, up to 20 M, one C per device, L). */
  GREETING_LINES: 200,
  /** M blocks of one metadata (the Cube sends at most a handful). */
  METADATA_PARTS: 20,
  /** A Cube pairs 50 devices at most (its "free memory slots" start at 50). */
  DEVICES: 100,
  ROOMS: 100,
  /** Characters kept of a room or device name. */
  NAME_CHARS: 40,
  /** Entries of one L message (every paired device at most). */
  LIST_ENTRIES: 200,
});

/**
 * Gladys waits 5 s for the acknowledgement of a command: past this budget,
 * counted from the moment the command arrives, nothing is sent (an action
 * must never run after Gladys showed a failure).
 */
export const COMMAND_BUDGET_MS = 3_500;
/** Room kept after the fresh read for the command itself. */
export const COMMAND_MIN_SEND_MS = 800;
/** Room needed to start the fresh read at all. */
export const COMMAND_MIN_READ_MS = 1_200;
/** Once sent, Gladys gets its answer at the latest this long after the command arrived. */
export const COMMAND_ACK_MS = 4_300;
/** After a command was sent, the Cube is read again this soon to show the result. */
export const READ_AFTER_COMMAND_MS = 5_000;

const SECOND = 1000;
const MINUTE = 60 * SECOND;

export const INTERVALS = Object.freeze({
  /** The Cube is read (`l:`, its own cache, no radio) every minute. */
  READ_MS: MINUTE,
  /** Cube unreachable: first retry (never sooner than the reading), then doubled. */
  RETRY_MIN_MS: MINUTE,
  RETRY_MAX_MS: 10 * MINUTE,
  /** With the connection kept, the Cube is reconnected this often (fresh rooms and names). */
  RECONNECT_MS: 6 * 60 * MINUTE,
  /** A stable value is published again after this long (dated recently in Gladys). */
  HEARTBEAT_MS: 10 * MINUTE,
  /** The test button answers within this delay (its manifest timeout is 30 s). */
  TEST_MS: 25 * SECOND,
  /** The time of the last attempt is written to /data at most this often. */
  ATTEMPT_SAVE_MS: MINUTE,
});

/** POST /state admits 300 states per minute per integration: we keep under. */
export const STATES_PER_MINUTE = 250;

/** The radio duty cycle (%) from which the status warns: a command may be queued or dropped. */
export const DUTY_CYCLE_WARNING = 80;
