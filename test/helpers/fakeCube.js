// -----------------------------------------------------------------------------
// A fake MAX! Cube behind the TCP transport of src/cube/client.js: it greets
// every connection (H, M, C..., L), answers `l:` and `s:`, closes on `q:`,
// and records everything written to it. No test touches the network.
// -----------------------------------------------------------------------------

import {
  DEFAULT_STATES,
  DEVICES,
  DOC_H,
  ROOMS,
  encodeC,
  encodeL,
  encodeM,
} from '../fixtures/cube.js';

export function createFakeCube({
  states = DEFAULT_STATES(),
  hello = DOC_H,
  rooms = ROOMS,
  devices = DEVICES,
  block,
} = {}) {
  const cube = {
    states,
    hello,
    rooms,
    devices,
    block,
    /** Every connection made: { lines, open, socket, deliver }. */
    connections: [],
    /** Connections open now. */
    open: 0,
    /** The most connections open at once (a Cube accepts one). */
    peak: 0,
    /** The connection is refused (nothing listens). */
    refuse: false,
    /** The connection opens but the Cube stays silent (no greeting, no answers). */
    silent: false,
    /** `l:` is never answered (the greeting still comes). */
    ignoreList: false,
    /** `s:` is never answered. */
    ignoreSend: false,
    /** The S answer: result 0 = processed, 1 = discarded. */
    sResult: 0,
    dutyCycle: 0,
    freeSlots: 49,
    /** Replaces the whole greeting: an array of lines. */
    greeting: null,
    /** The L line of the current states. */
    listLine: () => encodeL(cube.states),
    /** What was written with `s:` on every connection, in order. */
    get sent() {
      return cube.connections.flatMap((c) => c.lines.filter((l) => l.startsWith('s:')));
    },
    /** What was written, every connection. */
    get lines() {
      return cube.connections.flatMap((c) => c.lines);
    },
    /** An L the Cube sends on its own, on every open connection. */
    push(next = cube.states) {
      cube.states = next;
      for (const c of cube.connections) if (c.open) c.deliver(cube.listLine());
    },
    /** The Cube closes every connection (another client took it). */
    dropAll() {
      for (const c of cube.connections) if (c.open) c.close();
    },
    async connect(address, { timeoutMs } = {}) {
      cube.addresses = cube.addresses ?? [];
      cube.addresses.push({ ...address, timeoutMs });
      if (cube.refuse) {
        const err = new Error('ECONNREFUSED');
        err.kind = 'unreachable';
        err.notSent = true;
        throw err;
      }
      const listeners = { data: [], close: [] };
      const connection = {
        lines: [],
        open: true,
        pending: '',
        deliver(line) {
          if (!connection.open) return;
          for (const fn of listeners.data) fn(Buffer.from(`${line}\r\n`, 'latin1'));
        },
        close() {
          if (!connection.open) return;
          connection.open = false;
          cube.open -= 1;
          for (const fn of listeners.close) fn();
        },
      };
      connection.socket = {
        write(text) {
          if (!connection.open) throw new Error('closed');
          connection.pending += String(text);
          const parts = connection.pending.split('\r\n');
          connection.pending = parts.pop();
          for (const line of parts) {
            connection.lines.push(line);
            setImmediate(() => cube.answer(connection, line));
          }
          return true;
        },
        destroy() {
          connection.close();
        },
        on(event, fn) {
          listeners[event].push(fn);
        },
      };
      cube.connections.push(connection);
      cube.open += 1;
      cube.peak = Math.max(cube.peak, cube.open);
      if (!cube.silent) {
        setImmediate(() => {
          for (const line of cube.greet()) connection.deliver(line);
        });
      }
      return connection.socket;
    },
    greet() {
      if (cube.greeting) return cube.greeting;
      return [
        cube.hello,
        ...encodeM(cube.rooms, cube.devices, { block: cube.block }),
        ...cube.devices.map((d) => encodeC(d)),
        cube.listLine(),
      ];
    },
    answer(connection, line) {
      if (!connection.open || cube.silent) return;
      if (line === 'q:') {
        connection.close();
      } else if (line === 'l:') {
        if (!cube.ignoreList) connection.deliver(cube.listLine());
      } else if (line.startsWith('s:')) {
        if (cube.ignoreSend) return;
        if (cube.sResult === 0) cube.freeSlots -= 1;
        const hex = (n) => n.toString(16).padStart(2, '0');
        connection.deliver(`S:${hex(cube.dutyCycle)},${cube.sResult},${hex(cube.freeSlots)}`);
      }
    },
  };
  cube.connect = cube.connect.bind(cube);
  return cube;
}
