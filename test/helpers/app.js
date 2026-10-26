// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, a fake Cube and a virtual clock,
// through the exact wiring of the container (src/handlers.js).
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { MaxCubeApp } from '../../src/app.js';
import { registerHandlers } from '../../src/handlers.js';
import { createMemoryStore } from '../../src/store.js';
import { createFakeCube } from './fakeCube.js';
import { createFakeClock } from './fakeTimers.js';

export const SELECTOR = 'maxcube';
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const NOW = Date.parse('2026-10-25T10:00:00Z');
export const CONFIG = { host: '192.168.1.40' };
export const ALLOW = { ...CONFIG, allow_setpoint: true, allow_mode: true };

export const ext = (kind, id, key) => `ext:${SELECTOR}:${kind}:${id}${key ? `:${key}` : ''}`;

export function createLogger() {
  const lines = [];
  const log = (...args) => lines.push(args.map(String).join(' '));
  return { lines, info: log, warn: log, error: log, debug: log };
}

/** A few turns of the event loop: the fake Cube answers on setImmediate. */
export async function settle(turns = 6) {
  for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

export async function setup({
  config = CONFIG,
  devices = [],
  cube = createFakeCube(),
  store = createMemoryStore(),
  connect,
} = {}) {
  const gladys = createFakeGladys({ selector: SELECTOR, config, devices });
  const { clock, timers, advance, delays } = createFakeClock(0);
  let drift = 0;
  const logger = createLogger();
  const app = new MaxCubeApp({
    gladys,
    logger,
    connect: connect ?? cube.connect,
    now: () => NOW + clock.now,
    // A real monotonic clock moves between two reads of it: 1 µs per call
    // here, so that a decision reading the clock twice is caught.
    monotonic: () => clock.now + (drift += 0.001),
    timers,
    store,
    // The fake Cube frees its slot at once: no wait on the virtual clock.
    // (The real-TCP tests keep the default, on a Cube with one client slot.)
    reopenDelayMs: 0,
  });
  registerHandlers(gladys, app, logger);
  /** Gladys connects: the app starts and reads the Cube at once (when due). */
  const start = async () => {
    await gladys.connect();
    await advance(0);
    await settle();
  };
  const wait = async (ms) => {
    await advance(ms);
    await settle();
  };
  /** Create every discovered device in Gladys, as the user would. */
  const createAll = async () => {
    for (const device of gladys.fake.discoveredDevices) await gladys.fake.deviceCreated(device);
    await settle();
  };
  return {
    app,
    gladys,
    cube,
    clock,
    timers,
    store,
    logger,
    start,
    wait,
    advance,
    delays,
    createAll,
  };
}

export const status = (gladys) => gladys.fake.connectionStatus;
export const last = (gladys, id) => gladys.fake.lastState(id);
export const deviceOf = (gladys, kind, id) =>
  gladys.devices.find((d) => d.external_id === ext(kind, id));
export const featureOf = (gladys, kind, id, key) =>
  deviceOf(gladys, kind, id).features.find((f) => f.external_id === ext(kind, id, key));
export const command = (gladys, kind, id, key, value) =>
  gladys.fake.setValue(deviceOf(gladys, kind, id), featureOf(gladys, kind, id, key), value);
/** The bytes of the last `s:` command written to the Cube. */
export const lastSent = (cube) => {
  const line = cube.sent.at(-1);
  return line ? [...Buffer.from(line.slice(2), 'base64')] : undefined;
};
