// -----------------------------------------------------------------------------
// One TCP connection to a MAX! Cube (it accepts a single client): the lines
// it sends are read as they come, bounded in size and number, and dispatched
// (H, M, C, L, S); `l:` and `s:` are exchanges answered by L and S, one at a
// time; an L that answers nothing is a push (the Cube sends one when a
// device reports, while the connection is kept). Ported from the Commander /
// Connection of python-maxcube-api (MIT). Nothing the Cube sends is logged.
// -----------------------------------------------------------------------------

import net from 'node:net';
import { LIMITS, TIMEOUTS } from '../constants.js';
import {
  ProtocolError,
  decodeMetadata,
  parseC,
  parseH,
  parseL,
  parseLine,
  parseMPart,
  parseMetadata,
  parseS,
} from './protocol.js';

export const ERROR_KINDS = Object.freeze({
  /** No connection: nothing was sent. */
  UNREACHABLE: 'unreachable',
  TIMEOUT: 'timeout',
  /** The Cube closed the connection (another client took it?), or we did. */
  CLOSED: 'closed',
  /** An answer that is not what the protocol says. */
  PROTOCOL: 'protocol',
  /** The Cube discarded the command (S result 1: radio budget or memory). */
  REJECTED: 'rejected',
  /** Too late to start: nothing was sent. */
  LATE: 'late',
});

export class CubeError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'CubeError';
    this.kind = kind;
    Object.assign(this, extra);
  }
}

/** The reason of an error for a log or a message: its kind, never what the Cube sent. */
export const errorReason = (err) => err?.kind ?? err?.code ?? 'error';

/**
 * A real TCP connection -> { write(text), destroy(), on('data' | 'close', fn) }.
 * Rejects UNREACHABLE when nothing accepted it in time.
 */
export function tcpConnect({ host, port }, { timeoutMs = TIMEOUTS.CONNECT } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new CubeError(ERROR_KINDS.UNREACHABLE, err?.code ?? 'unreachable', { notSent: true }));
    };
    socket.setTimeout(Math.max(1, timeoutMs), () => fail({ code: 'timeout' }));
    socket.once('error', fail);
    socket.once('connect', () => {
      if (settled) return;
      settled = true;
      socket.setTimeout(0);
      socket.setNoDelay(true);
      socket.removeListener('error', fail);
      // Errors after the connection: a close follows, the connection handles it.
      socket.on('error', () => {});
      resolve({
        write: (text) => socket.write(text, 'latin1'),
        destroy: () => socket.destroy(),
        on: (event, fn) => socket.on(event === 'close' ? 'close' : 'data', fn),
      });
    });
  });
}

export class CubeConnection {
  /**
   * @param {object} socket  { write, destroy, on } (tcpConnect, or a fake)
   * @param {object} options { timers, monotonic, onPush(entries) }
   */
  constructor(socket, { timers = globalThis, monotonic = () => performance.now(), onPush } = {}) {
    this.socket = socket;
    this.timers = timers;
    this.monotonic = monotonic;
    this.onPush = onPush;
    this.closed = false;
    this.chunks = [];
    this.size = 0;
    /** The greeting: H, the M blocks, one C per device, then the first L. */
    this.hello = undefined;
    this.metadataParts = [];
    this.metadata = undefined;
    this.configs = new Map();
    this.badConfigs = 0;
    this.list = undefined;
    this.greeting = undefined;
    this.greetingLines = 0;
    this.greetingBytes = 0;
    /** The exchange waiting for its answer: { type, resolve, reject, timer }. */
    this.waiter = undefined;
    /** Exchanges waiting their turn, the priority ones (a stop) first. */
    this.queue = [];
    /** Why we closed: `preempted` (a stop needed the line), for the errors of what was cut. */
    this.closeReason = undefined;
    /** When the exchange in flight was written (monotonic), or undefined. */
    this.busySince = undefined;
    socket.on('data', (data) => this.onData(data));
    /** Resolves once the socket is really closed (the Cube sees our slot free). */
    this.socketClosed = new Promise((resolve) => {
      this.markSocketClosed = resolve;
    });
    socket.on('close', () => {
      this.markSocketClosed();
      this.onClose();
    });
  }

  // --- Reading lines ----------------------------------------------------------------

  onData(data) {
    if (this.closed) return;
    // A greeting still coming is never cut for a stop (app.js clearWay).
    this.lastDataAt = this.monotonic();
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'latin1');
    let start = 0;
    for (;;) {
      const at = chunk.indexOf(0x0a, start);
      if (at === -1) break;
      const piece = chunk.subarray(start, at);
      start = at + 1;
      const line = this.chunks.length ? Buffer.concat([...this.chunks, piece]) : piece;
      this.chunks = [];
      this.size = 0;
      if (line.length > LIMITS.LINE_BYTES) {
        this.fail(new CubeError(ERROR_KINDS.PROTOCOL, 'line too long'));
        return;
      }
      const text = line.toString('latin1').replace(/\r$/, '');
      try {
        this.handle(text);
      } catch (err) {
        this.fail(
          err instanceof ProtocolError
            ? new CubeError(ERROR_KINDS.PROTOCOL, err.message)
            : new CubeError(ERROR_KINDS.PROTOCOL, 'unexpected'),
        );
        return;
      }
      if (this.closed) return;
    }
    if (start < chunk.length) {
      const rest = chunk.subarray(start);
      this.chunks.push(rest);
      this.size += rest.length;
      if (this.size > LIMITS.LINE_BYTES) {
        this.fail(new CubeError(ERROR_KINDS.PROTOCOL, 'line too long'));
      }
    }
  }

  handle(text) {
    const message = parseLine(text);
    if (!message) return;
    if (this.greeting) {
      this.greetingLines += 1;
      this.greetingBytes += text.length;
      if (
        this.greetingLines > LIMITS.GREETING_LINES ||
        this.greetingBytes > LIMITS.GREETING_BYTES
      ) {
        throw new ProtocolError('greeting too long');
      }
    }
    switch (message.type) {
      case 'H':
        this.hello = parseH(message.arg);
        return;
      case 'M': {
        const part = parseMPart(message.arg);
        if (this.metadataParts.count !== part.count) {
          this.metadataParts = [];
          this.metadataParts.count = part.count;
        }
        this.metadataParts[part.index] = part.data;
        let complete = true;
        for (let i = 0; i < part.count; i += 1) {
          if (typeof this.metadataParts[i] !== 'string') complete = false;
        }
        if (complete) {
          this.metadata = parseMetadata(decodeMetadata([...this.metadataParts]));
          this.metadataParts = [];
        }
        return;
      }
      case 'C': {
        if (this.configs.size >= LIMITS.DEVICES * 2) throw new ProtocolError('too many C');
        let config;
        try {
          config = parseC(message.arg);
        } catch {
          // One configuration that does not decode (or names another
          // address): that device has none, the Cube is read all the same.
          this.badConfigs += 1;
          return;
        }
        this.configs.set(config.rfAddress, config);
        return;
      }
      case 'L': {
        const entries = parseL(message.arg);
        this.list = entries;
        if (this.waiter?.type === 'L') {
          this.settle(entries);
        } else if (this.greeting) {
          // A greeting without its whole metadata is not a Cube (or not yet
          // one): never an empty installation.
          if (!this.hello || !this.metadata) throw new ProtocolError('greeting without metadata');
          const greeting = this.greeting;
          this.greeting = undefined;
          this.timers.clearTimeout(greeting.timer);
          greeting.resolve(this.snapshot());
        } else {
          this.onPush?.(entries);
        }
        return;
      }
      case 'S': {
        const answer = parseS(message.arg);
        if (this.waiter?.type === 'S') this.settle(answer);
        return;
      }
      default:
        // A, F, N... : nothing this integration uses.
        return;
    }
  }

  /** What the greeting gave: the hello, the rooms and devices, the configurations, the first list. */
  snapshot() {
    return {
      hello: this.hello,
      metadata: this.metadata ?? { rooms: [], devices: [] },
      configs: new Map(this.configs),
      list: this.list ?? [],
    };
  }

  settle(value) {
    const waiter = this.waiter;
    this.waiter = undefined;
    this.busySince = undefined;
    this.timers.clearTimeout(waiter.timer);
    waiter.resolve(value);
  }

  onClose() {
    this.fail(new CubeError(ERROR_KINDS.CLOSED, 'connection closed'));
  }

  fail(err) {
    this.mark(err);
    const { waiter, greeting } = this;
    this.waiter = undefined;
    this.greeting = undefined;
    this.busySince = undefined;
    if (waiter) {
      this.timers.clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    if (greeting) {
      this.timers.clearTimeout(greeting.timer);
      greeting.reject(err);
    }
    this.close();
  }

  /**
   * Closes the connection; `quit`: tells the Cube first (`q:`), so it frees
   * the slot at once; `preempted`: a stop needs the line, the errors of what
   * is cut say so.
   */
  close({ quit = false, preempted = false } = {}) {
    if (this.closed) return;
    if (preempted) this.closeReason = 'preempted';
    this.closed = true;
    this.chunks = [];
    this.size = 0;
    try {
      if (quit) this.socket.write('q:\r\n');
      this.socket.destroy();
    } catch {
      // already gone
    }
    if (this.waiter || this.greeting) {
      this.fail(new CubeError(ERROR_KINDS.CLOSED, 'connection closed'));
    }
    // What waited its turn was never written.
    const queued = this.queue;
    this.queue = [];
    for (const job of queued) {
      job.reject(
        this.mark(new CubeError(ERROR_KINDS.CLOSED, 'connection closed', { notSent: true })),
      );
    }
  }

  /** An error of this connection, marked when we cut it for a stop. */
  mark(err) {
    if (this.closeReason === 'preempted') err.preempted = true;
    return err;
  }

  // --- The greeting and the exchanges ------------------------------------------------

  /** Resolves with the greeting once its L arrived, within `timeoutMs`. */
  waitGreeting(timeoutMs) {
    if (this.closed) {
      return Promise.reject(new CubeError(ERROR_KINDS.CLOSED, 'connection closed'));
    }
    if (this.list) return Promise.resolve(this.snapshot());
    return new Promise((resolve, reject) => {
      const greeting = { resolve, reject, timer: undefined };
      greeting.timer = this.timers.setTimeout(
        () => {
          if (this.greeting === greeting) {
            this.fail(new CubeError(ERROR_KINDS.TIMEOUT, 'no greeting in time'));
          }
        },
        Math.max(1, timeoutMs),
      );
      this.greeting = greeting;
    });
  }

  /**
   * One exchange: `text` written, the answer of `type` awaited within
   * `timeoutMs`. `beforeSend()` runs right before the write: what it throws
   * is rethrown marked `notSent`. Exchanges run one after the other; a
   * `priority` one (a stop) goes before every exchange still waiting, never
   * before the one in flight.
   */
  exchange(type, text, timeoutMs, { beforeSend, priority = false } = {}) {
    return new Promise((resolve, reject) => {
      const job = { type, text, timeoutMs, beforeSend, priority, resolve, reject };
      if (priority) {
        const at = this.queue.findIndex((queued) => !queued.priority);
        this.queue.splice(at === -1 ? this.queue.length : at, 0, job);
      } else {
        this.queue.push(job);
      }
      this.next();
    });
  }

  /** The type of the exchange in flight ('L', 'S'), or undefined. */
  get inFlight() {
    return this.waiter?.type;
  }

  next() {
    if (this.waiter || this.queue.length === 0) return;
    const job = this.queue.shift();
    this.exchangeNow(job).then(
      (value) => {
        job.resolve(value);
        this.next();
      },
      (err) => {
        job.reject(err);
        this.next();
      },
    );
  }

  exchangeNow({ type, text, timeoutMs, beforeSend }) {
    if (this.closed) {
      return Promise.reject(
        this.mark(new CubeError(ERROR_KINDS.CLOSED, 'connection closed', { notSent: true })),
      );
    }
    if (beforeSend) {
      try {
        beforeSend();
      } catch (err) {
        return Promise.reject(Object.assign(err, { notSent: true }));
      }
    }
    const timeout = typeof timeoutMs === 'function' ? timeoutMs() : timeoutMs;
    if (!(timeout >= 1)) {
      return Promise.reject(new CubeError(ERROR_KINDS.LATE, 'too late', { notSent: true }));
    }
    return new Promise((resolve, reject) => {
      const waiter = { type, resolve, reject, timer: undefined };
      waiter.timer = this.timers.setTimeout(() => {
        if (this.waiter === waiter) {
          this.fail(new CubeError(ERROR_KINDS.TIMEOUT, 'no answer in time', { sent: true }));
        }
      }, timeout);
      this.waiter = waiter;
      this.busySince = this.monotonic();
      try {
        this.socket.write(`${text}\r\n`);
      } catch {
        this.fail(new CubeError(ERROR_KINDS.CLOSED, 'connection closed', { notSent: true }));
      }
    });
  }

  /** `l:` -> the entries of the L answer. */
  requestList(timeoutMs = TIMEOUTS.LIST) {
    return this.exchange('L', 'l:', timeoutMs);
  }

  /** `s:<base64>` -> { dutyCycle, result, freeSlots }; REJECTED (sent) when the Cube discarded it. */
  async send(base64, timeoutMs = TIMEOUTS.SEND, { beforeSend, priority = false } = {}) {
    const answer = await this.exchange('S', `s:${base64}`, timeoutMs, { beforeSend, priority });
    if (answer.result !== 0) {
      throw new CubeError(ERROR_KINDS.REJECTED, 'command discarded', { sent: true, answer });
    }
    return answer;
  }

  /** Resolves when the socket is closed, or after `ms` at the latest. */
  whenClosed(ms) {
    let handle;
    const limit = new Promise((resolve) => {
      handle = this.timers.setTimeout(resolve, ms);
    });
    return Promise.race([this.socketClosed, limit]).finally(() => this.timers.clearTimeout(handle));
  }

  /** Whether the exchange in flight has had no answer for `ms` (monotonic). */
  stalled(ms, mono = this.monotonic()) {
    return this.busySince !== undefined && mono - this.busySince >= ms;
  }
}

/**
 * Opens a connection and waits for the greeting, all within `timeoutMs`.
 * -> { connection, greeting }. Nothing is written before the greeting.
 */
export async function openConnection(
  address,
  {
    connect = tcpConnect,
    timeoutMs = TIMEOUTS.CONNECT,
    timers,
    monotonic,
    onPush,
    onConnection,
  } = {},
) {
  const mono = monotonic ?? (() => performance.now());
  const started = mono();
  const socket = await connect(address, { timeoutMs });
  const connection = new CubeConnection(socket, { timers, monotonic: mono, onPush });
  // The caller may cut a greeting that does not come (a stop needs the line).
  onConnection?.(connection);
  try {
    const left = timeoutMs - (mono() - started);
    if (left < 1) throw new CubeError(ERROR_KINDS.TIMEOUT, 'no greeting in time');
    const greeting = await connection.waitGreeting(left);
    return { connection, greeting };
  } catch (err) {
    connection.close();
    throw Object.assign(err, { notSent: true });
  }
}
