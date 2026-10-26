// -----------------------------------------------------------------------------
// MaxCubeApp: the integration. One eQ-3 MAX! Cube, read through its local TCP
// port 62910 (one client at a time: this integration opens one connection
// and nothing else).
//
//   start(config)  (re)connects: the Cube greeted (rooms, devices, their
//                  configuration, the live values), Discovery published, the
//                  reading loop started. The same configuration again (Gladys
//                  reconnected) only publishes everything again.
//   reading loop   `l:` every minute (the cache of the Cube, no radio), on
//                  the connection kept open (an L pushed by the Cube between
//                  two reads is published at once), or on a connection opened
//                  and closed for each read (`keep_connection` off, so the
//                  MAX! software can connect in between). Unreachable: a
//                  retry 1 to 10 min later. The loop never reads sooner than
//                  the interval, a restart included (the time of the last
//                  attempt is kept in /data); the reads that follow a command
//                  (5 s, 30 s, 1 min, 2 min after it) check what it did.
//   setValue       the commands, see "Commands" below.
//
// One loop, one timer: halt() bumps an epoch, and a run of an older epoch
// never schedules itself again. The created devices are read from
// `gladys.devices`, which the SDK keeps up to date: never a copy of our own.
// Two clocks: `now` (wall clock) dates /data only; `monotonic` paces every
// delay, the command budgets and the state budget. Each decision reads the
// monotonic clock once and hands the instant on (dueAt(mono)): a real clock
// moves between two reads of it.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { Budget } from './budget.js';
import { normalizeConfig } from './config.js';
import {
  COMMAND_ACK_MS,
  COMMAND_BUDGET_MS,
  COMMAND_MIN_READ_MS,
  COMMAND_MIN_SEND_MS,
  DUTY_CYCLE_REFUSE,
  DUTY_CYCLE_WARNING,
  DUTY_FRESH_MS,
  FOLLOW_UPS_MS,
  INTERVALS,
  KINDS,
  SERIAL,
  SETPOINT,
  STATES_PER_MINUTE,
  STOP_RESEND_AFTER_MS,
  STOP_RESENDS,
  THERMOSTAT_FEATURES as TF,
  TIMEOUTS,
  VERIFY_GIVE_UP_MS,
} from './constants.js';
import { ERROR_KINDS, openConnection, tcpConnect } from './cube/client.js';
import {
  MODES,
  OFF_TEMPERATURE,
  buildTemperatureCommand,
  deviceState,
  isShutterContact,
  isThermostat,
  isWallThermostat,
  usable,
} from './cube/protocol.js';
import {
  THERMOSTAT_MODE,
  buildDevices,
  idsOf,
  modelStates,
  parseExternalId,
  setpointBounds,
} from './devices.js';
import { T } from './i18n.js';
import { createFileStore } from './store.js';

/** Entries per publishTransports call (the SDK refuses more). */
const TRANSPORTS_PER_CALL = 100;
/** The key of the last read attempt (wall clock) in /data. */
const ATTEMPT_KEY = 'lastAttemptAt';
const noop = () => {};
/** A setpoint as Gladys may send it: a plain decimal, never 0x14, 1e1 or " 21". */
const SETPOINT_TEXT = /^-?\d{1,3}(\.\d{1,3})?$/;

const kindOf = (type) => {
  if (isThermostat(type)) return KINDS.THERMOSTAT;
  if (isWallThermostat(type)) return KINDS.WALL;
  if (isShutterContact(type)) return KINDS.WINDOW;
  return undefined;
};

/** An error for Gladys, with what the Cube said underneath (never shown). */
const refusal = (message, cause) => (cause ? new Error(message, { cause }) : new Error(message));

/** Whether a thermostat state shows what a command asked: { mode, target } (target for manual). */
function applied(expect, state) {
  if (!usable(state)) return false;
  if (expect.mode === MODES.AUTO) {
    return state.mode === MODES.AUTO && (expect.target === 0 || state.target === expect.target);
  }
  return state.mode === MODES.MANUAL && state.target === expect.target;
}

export class MaxCubeApp {
  /**
   * @param {object} options
   * @param {import('@gladysassistant/integration-sdk').GladysIntegration} options.gladys
   * @param {object} [options.logger]
   * @param {Function} [options.connect] the TCP transport (tests inject a fake Cube)
   * @param {() => number} [options.now]
   * @param {() => number} [options.monotonic]
   * @param {{ setTimeout: Function, clearTimeout: Function }} [options.timers]
   * @param {object} [options.store] the /data store (src/store.js)
   */
  constructor({
    gladys,
    logger = createLogger({ name: 'maxcube' }),
    connect = tcpConnect,
    now = Date.now,
    monotonic = () => performance.now(),
    timers = globalThis,
    store = createFileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.connect = connect;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    this.budget = new Budget({ perMinute: STATES_PER_MINUTE, now: monotonic });
    this.budgetCursor = 0;
    /** Whether a configuration was given (start): commands wait for it. */
    this.loaded = false;
    this.rawConfig = {};
    this.config = normalizeConfig();
    this.configKey = null;
    this.connection = null;
    this.opening = null;
    /** What uses the connection now (reads, commands): with `keep_connection` off, closed at 0. */
    this.uses = 0;
    this.generation = 0;
    this.epoch = 0;
    this.timer = undefined;
    this.queue = Promise.resolve();
    /** The commands other than a stop, waiting their turn; `active`: the one running. */
    this.commands = [];
    this.active = undefined;
    this.pumping = false;
    /** The stops, one after the other, never behind another command. */
    this.stops = Promise.resolve();
    this.lastStatus = null;
    this.wantedStatus = null;
    this.gladysAway = false;
    this.lastAttemptWall = this.loadAttempt();
    this.attemptSavedWall = undefined;
    this.reset();
  }

  reset() {
    this.online = false;
    this.retryDelay = INTERVALS.RETRY_MIN_MS;
    this.nextTryAt = undefined;
    /** The reads that follow commands (monotonic instants, sorted). */
    this.followUps = [];
    /** What the commands sent and the follow-up reads check: serial -> expectation. */
    this.expectations = new Map();
    this.lastReadAt = undefined;
    this.notBefore = 0;
    this.connectedAt = 0;
    this.model = null;
    this.discoveredKey = null;
    this.transports = new Map();
  }

  // --- /data: the time of the last read attempt ------------------------------------

  loadAttempt() {
    const saved = Number(this.store.load()[ATTEMPT_KEY]);
    return Number.isFinite(saved) ? saved : undefined;
  }

  /** Kept BEFORE the read, at most once a minute: a restart never reads sooner than the interval. */
  async saveAttempt(wall) {
    this.lastAttemptWall = wall;
    if (
      this.attemptSavedWall !== undefined &&
      wall - this.attemptSavedWall < INTERVALS.ATTEMPT_SAVE_MS &&
      wall >= this.attemptSavedWall
    ) {
      return;
    }
    this.attemptSavedWall = wall;
    try {
      await this.store.save({ ...this.store.load(), [ATTEMPT_KEY]: wall });
    } catch (err) {
      this.logger.warn(`Saving the read time in /data failed (${err?.code ?? 'error'})`);
    }
  }

  // --- Lifecycle -------------------------------------------------------------------

  /** Run `task` after every start already queued. */
  enqueue(task) {
    const run = this.queue.then(task);
    this.queue = run.catch(() => {});
    return run;
  }

  /** (Re)start with a configuration. Calls are serialized. */
  start(rawConfig) {
    this.restrict(rawConfig);
    return this.enqueue(() => this.run(rawConfig));
  }

  /**
   * A permission taken away applies at once, not when the queued restart
   * runs: a command checked meanwhile is refused. (One given is applied by
   * the restart only.)
   */
  restrict(rawConfig) {
    const next = normalizeConfig(rawConfig);
    if (this.config.allowSetpoint && !next.allowSetpoint) {
      this.config = { ...this.config, allowSetpoint: false };
    }
    if (this.config.allowMode && !next.allowMode) {
      this.config = { ...this.config, allowMode: false };
    }
  }

  async stop() {
    this.generation += 1;
    this.halt();
    this.dropConnection({ quit: true });
  }

  /** Gladys went away: the loop stops, the connection to the Cube stays. */
  pause() {
    this.gladysAway = true;
    this.halt();
  }

  /** Clear the timer; the runs still in flight will not schedule again. */
  halt() {
    this.epoch += 1;
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  dropConnection({ quit = false, preempted = false } = {}) {
    const connection = this.connection;
    this.connection = null;
    connection?.close({ quit, preempted });
  }

  async run(rawConfig) {
    const config = normalizeConfig(rawConfig);
    const key = JSON.stringify(config);
    this.gladysAway = false;
    this.loaded = true;
    if (this.configKey === key && this.connection && !this.connection.closed) {
      await this.resume();
      return;
    }
    this.halt();
    this.dropConnection({ quit: true });
    const generation = ++this.generation;
    this.rawConfig = rawConfig ?? {};
    this.config = config;
    this.configKey = key;
    this.reset();
    this.lastStatus = null;
    this.wantedStatus = null;
    this.gladys.forgetPublishedStates?.();

    const invalid = this.configProblem(config);
    if (invalid) {
      await this.setStatus(false, invalid);
      return;
    }
    // Never sooner than the interval after the last attempt (a restart, a
    // configuration saved again): one read of each clock.
    const mono = this.monotonic();
    const since = this.now() - (this.lastAttemptWall ?? -Infinity);
    const wait = since >= 0 && since < INTERVALS.READ_MS ? INTERVALS.READ_MS - since : 0;
    this.notBefore = mono + wait;
    this.logger.info(`Using the MAX! Cube at ${config.cube.host}:${config.cube.port}`);
    if (wait > 0) await this.setStatus(false, T.status.waiting(wait));
    if (generation !== this.generation) return;
    this.schedule(mono);
  }

  configProblem(config) {
    if (config.hostError) {
      return (
        {
          empty: T.status.hostEmpty,
          credentials: T.status.hostCredentials,
        }[config.hostError] ?? T.status.hostInvalid
      );
    }
    return null;
  }

  /**
   * Gladys reconnected with the same configuration: the status, Discovery and
   * every value are published again (a restarted Gladys lost them), the
   * reading loop goes on where it was.
   */
  async resume() {
    this.halt();
    const status = this.wantedStatus;
    this.lastStatus = null;
    this.transports.clear();
    this.discoveredKey = null;
    this.gladys.forgetPublishedStates?.();
    if (status) await this.setStatus(status[0], status[1]);
    if (this.model) {
      await this.publishDiscovered();
      await this.publishStates();
    }
    await this.publishTransports();
    this.schedule(this.monotonic());
  }

  // --- The reading loop ----------------------------------------------------------------

  /** The earliest a read may start: the interval after the last one (a restart included). */
  earliestAt(mono) {
    const due =
      this.lastReadAt === undefined ? this.notBefore : this.lastReadAt + INTERVALS.READ_MS;
    return Math.max(due, mono);
  }

  /** When the next read of the loop is due, from the instant `mono` already read by the caller. */
  dueAt(mono) {
    let due = this.earliestAt(mono);
    if (this.nextTryAt !== undefined) due = Math.max(due, this.nextTryAt);
    if (this.followUps.length) due = Math.min(due, this.followUps[0]);
    return Math.max(due, mono);
  }

  /** One timer for the loop, armed for the next read. */
  schedule(mono = this.monotonic()) {
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
    const generation = this.generation;
    const epoch = this.epoch;
    const wait = Math.max(0, this.dueAt(mono) - mono);
    this.timer = this.timers.setTimeout(async () => {
      this.timer = undefined;
      try {
        await this.read(generation, epoch);
      } catch (err) {
        this.logger.error(`Loop failed (${err?.name ?? 'Error'})`);
      }
      if (this.current(generation, epoch)) this.schedule();
    }, wait);
  }

  /** May a loop of this generation and epoch go on? */
  current(generation, epoch = this.epoch) {
    return generation === this.generation && epoch === this.epoch;
  }

  /** Reads after a command written at `mono`: they check what it did. */
  addFollowUps(mono) {
    this.followUps = [...this.followUps, ...FOLLOW_UPS_MS.map((ms) => mono + ms)].sort(
      (a, b) => a - b,
    );
    this.nextTryAt = undefined;
    if (!this.gladysAway && this.config.cube) this.schedule(mono);
  }

  /**
   * One round of the reading loop. Never throws. `now`: the test button,
   * which only waits for the interval, not for the retry pause.
   */
  async read(generation, epoch, { now = false } = {}) {
    if (!this.config.cube || !this.current(generation, epoch)) return;
    const mono = this.monotonic();
    if (mono < (now ? this.earliestAt(mono) : this.dueAt(mono))) return;
    this.lastReadAt = mono;
    this.followUps = this.followUps.filter((at) => at > mono);
    await this.saveAttempt(this.now());
    if (!this.current(generation, epoch)) return;
    try {
      await this.fetch(generation, mono);
    } catch (err) {
      if (err?.preempted) {
        // Cut by a stop that needed the line: read again soon, not a failure.
        this.followUps = [mono + FOLLOW_UPS_MS[0], ...this.followUps].sort((a, b) => a - b);
        return;
      }
      if (this.current(generation, epoch)) await this.failed(err, mono);
      return;
    }
    if (!this.current(generation, epoch)) return;
    await this.succeeded(mono);
  }

  /** The Cube read: a new connection and its greeting, or `l:` on the one open. */
  async fetch(generation, mono) {
    if (
      this.connection &&
      !this.connection.closed &&
      this.uses === 0 &&
      mono - this.connectedAt >= INTERVALS.RECONNECT_MS
    ) {
      // Fresh rooms, names and configurations now and then.
      this.dropConnection({ quit: true });
    }
    this.uses += 1;
    try {
      const { connection, opened } = await this.acquire(TIMEOUTS.CONNECT);
      if (generation !== this.generation || opened) return;
      const entries = await connection.requestList(TIMEOUTS.LIST);
      if (generation !== this.generation || connection !== this.connection) return;
      this.applyList(this.model, entries);
      this.lastListAt = this.monotonic();
    } finally {
      this.release();
    }
  }

  /** The connection open, or a new one (its greeting gives a fresh model). -> { connection, opened } */
  async acquire(timeoutMs) {
    if (this.connection && !this.connection.closed) return { connection: this.connection };
    const opened = await this.open(timeoutMs);
    return { connection: opened.connection, opened: true };
  }

  /** One use of the connection less: with `keep_connection` off, closed once unused. */
  release() {
    this.uses = Math.max(0, this.uses - 1);
    if (this.uses === 0 && !this.config.keepConnection) this.dropConnection({ quit: true });
  }

  /** `release()` once `promise` ends. */
  releaseAfter(promise) {
    promise.then(noop, noop).then(() => this.release());
  }

  /**
   * Opens the one connection (the Cube accepts a single client): a second
   * caller waits for the opening in progress. The greeting gives the model.
   * -> { connection, greeting }.
   */
  open(timeoutMs) {
    if (this.opening) return this.opening;
    const generation = this.generation;
    this.dropConnection({ quit: true });
    const address = this.config.cube;
    this.opening = (async () => {
      let opened;
      try {
        opened = await openConnection(address, {
          connect: this.connect,
          timeoutMs,
          timers: this.timers,
          monotonic: this.monotonic,
        });
      } finally {
        this.opening = null;
      }
      if (generation !== this.generation || this.connection) {
        // Stopped or replaced meanwhile: this one is not kept.
        opened.connection.close({ quit: true });
        throw Object.assign(new Error('replaced'), { kind: ERROR_KINDS.CLOSED, notSent: true });
      }
      let model;
      try {
        model = this.buildModel(opened.greeting);
      } catch (err) {
        opened.connection.close({ quit: true });
        throw err;
      }
      if (opened.connection.badConfigs) {
        this.logger.warn(`${opened.connection.badConfigs} device configuration(s) not readable`);
      }
      opened.connection.onPush = (entries) => this.pushed(opened.connection, entries);
      this.connection = opened.connection;
      this.connectedAt = this.monotonic();
      this.model = model;
      return opened;
    })();
    return this.opening;
  }

  /** The Cube sent an L on its own (a device reported): the devices it lists, published at once. */
  pushed(connection, entries) {
    if (connection !== this.connection || !this.model || !this.online || this.gladysAway) return;
    this.applyList(this.model, entries, { partial: true });
    void this.publishStates();
    void this.publishTransports();
  }

  /** The greeting -> the model: the Cube, its rooms and devices with their configuration and values. */
  buildModel(greeting) {
    const { hello, metadata, configs, list } = greeting;
    if (!hello) {
      throw Object.assign(new Error('no hello'), { kind: ERROR_KINDS.PROTOCOL, notSent: true });
    }
    const rooms = new Map(metadata.rooms.map((room) => [room.id, room.name]));
    const known = metadata.devices.filter((item) => kindOf(item.type));
    // Two devices on one radio address would share values and commands: neither is kept.
    const rfCount = new Map();
    for (const item of known) rfCount.set(item.rfAddress, (rfCount.get(item.rfAddress) ?? 0) + 1);
    const seen = new Set();
    const devices = [];
    let dropped = 0;
    for (const item of known) {
      if (!SERIAL.test(item.serial) || seen.has(item.serial) || rfCount.get(item.rfAddress) > 1) {
        dropped += 1;
        continue;
      }
      seen.add(item.serial);
      const config = configs.get(item.rfAddress);
      devices.push({
        kind: kindOf(item.type),
        type: item.type,
        serial: item.serial,
        rfAddress: item.rfAddress,
        name: item.name || item.serial,
        roomId: item.roomId,
        roomName: rooms.get(item.roomId),
        config: config && config.type === item.type ? config : undefined,
        state: undefined,
      });
    }
    if (dropped) {
      this.logger.warn(`${dropped} device(s) ignored (no usable serial number, or shared address)`);
    }
    const mono = this.monotonic();
    const model = {
      cube: {
        serial: hello.serial,
        firmware: hello.firmware,
        dutyCycle: hello.dutyCycle,
        freeSlots: hello.freeSlots,
        dutyAt: mono,
      },
      rooms: rooms.size,
      devices,
    };
    this.applyList(model, list);
    return model;
  }

  /** The live values of an L message applied to the devices of the model (`partial`: a push). */
  applyList(model, entries, { partial = false } = {}) {
    if (!model) return;
    const byRf = new Map(entries.map((entry) => [entry.rfAddress, entry]));
    for (const item of model.devices) {
      const entry = byRf.get(item.rfAddress);
      if (entry) item.state = deviceState(entry, item.type);
      else if (!partial) item.state = undefined;
    }
  }

  /** The duty cycle and free slots the Cube gave last, while fresh (10 min), else undefined. */
  duty(mono = this.monotonic()) {
    const cube = this.model?.cube;
    if (!cube || cube.dutyAt === undefined || mono - cube.dutyAt > DUTY_FRESH_MS) return undefined;
    return { dutyCycle: cube.dutyCycle, freeSlots: cube.freeSlots };
  }

  /** An S answer: the newest duty cycle and free slots. */
  noteAnswer(answer) {
    if (!this.model || !answer) return;
    this.model.cube.dutyCycle = answer.dutyCycle;
    this.model.cube.freeSlots = answer.freeSlots;
    this.model.cube.dutyAt = this.monotonic();
  }

  /** A reading failed: a retry with a growing delay, never sooner than the interval. */
  async failed(err, mono) {
    const wasOnline = this.online;
    this.online = false;
    if (this.uses === 0) this.dropConnection();
    const delay = Math.max(this.retryDelay, INTERVALS.READ_MS);
    this.retryDelay = Math.min(this.retryDelay * 2, INTERVALS.RETRY_MAX_MS);
    this.nextTryAt = mono + delay;
    await this.publishTransports();
    if (wasOnline || delay <= INTERVALS.RETRY_MIN_MS) {
      // Our own message: a kind, never the text of the answer.
      this.logger.warn(`The Cube fails: ${err?.kind ?? err?.code ?? 'error'}`);
    }
    await this.setStatus(
      false,
      err?.kind === ERROR_KINDS.PROTOCOL
        ? T.status.notCube(delay)
        : T.status.unreachable(err, delay),
    );
  }

  async succeeded(mono) {
    this.online = true;
    this.retryDelay = INTERVALS.RETRY_MIN_MS;
    this.nextTryAt = undefined;
    this.verify(mono);
    const devices = this.discoveredDevices();
    const key = JSON.stringify(devices);
    if (key !== this.discoveredKey) await this.publishDiscovered(devices);
    await this.publishStates();
    await this.publishTransports();
    await this.setStatus(true, this.okMessage());
  }

  /**
   * The follow-up reads: each command checked against the device. A stop not
   * applied is sent again (3 times at most); any command still not applied
   * 2 min after its last write is said in the logs (and in the status for a
   * stop, until the device shows it or another command replaces it).
   */
  verify(mono) {
    for (const [serial, expect] of this.expectations) {
      const item = this.model?.devices.find((d) => d.serial === serial && d.kind === expect.kind);
      if (!item) {
        this.expectations.delete(serial);
        continue;
      }
      if (applied(expect, item.state)) {
        if (expect.failed) this.logger.info(`A ${expect.action} was applied in the end`);
        this.expectations.delete(serial);
        continue;
      }
      const since = mono - expect.sentAt;
      if (expect.action === 'stop' && expect.resends < STOP_RESENDS) {
        if (since >= STOP_RESEND_AFTER_MS && !expect.resending)
          void this.resendStop(serial, expect);
        continue;
      }
      if (since >= VERIFY_GIVE_UP_MS && !expect.failed) {
        expect.failed = true;
        this.logger.warn(
          `A ${expect.action} sent to a ${expect.kind} was not applied (${expect.resends + 1} send(s))`,
        );
        if (expect.action !== 'stop') this.expectations.delete(serial);
      }
    }
  }

  /** A stop not seen applied: sent again through the stop lane (never past a fresh radio budget). */
  async resendStop(serial, expect) {
    const duty = this.duty();
    if (duty && (duty.dutyCycle >= DUTY_CYCLE_REFUSE || duty.freeSlots === 0)) return;
    // Counted when tried: a resend that cannot leave is not tried for ever.
    const attempt = expect.resends + 1;
    expect.resends = attempt;
    expect.resending = true;
    try {
      const job = this.newJob(
        { kind: expect.kind, id: serial },
        { action: 'stop', value: THERMOSTAT_MODE.OFF, protective: true },
      );
      this.logger.warn(`A stop was not applied by a ${expect.kind}: sent again (${attempt})`);
      await this.runStop(job);
    } catch (err) {
      this.logger.warn(`Sending the stop again failed (${err?.cause?.kind ?? 'error'})`);
    } finally {
      expect.resending = false;
    }
    // The new write replaced the expectation: it keeps the count.
    const next = this.expectations.get(serial);
    if (next && next !== expect && next.action === 'stop') next.resends = attempt;
  }

  /**
   * `wantedStatus` is what Gladys should show (kept even when sending it
   * failed: resume() sends it again); `lastStatus` only skips a repeat.
   */
  async setStatus(connected, message) {
    this.wantedStatus = [connected, message];
    const key = JSON.stringify(this.wantedStatus);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    await this.gladys.setConnectionStatus(connected, message).catch((err) => {
      if (this.lastStatus === key) this.lastStatus = null;
      this.logger.warn(`Connection status not sent: ${err.message}`);
    });
  }

  // --- Publishing ----------------------------------------------------------------------

  discoveredDevices() {
    return this.model ? buildDevices(this.gladys, this.model, this.config.language) : [];
  }

  okMessage() {
    const model = this.model;
    const notes = [];
    const duty = this.duty();
    if (duty && Number.isFinite(duty.dutyCycle) && duty.dutyCycle >= DUTY_CYCLE_WARNING) {
      notes.push(T.notes.dutyCycle(duty.dutyCycle));
    }
    const missing = model.devices.filter((d) => !d.state).length;
    if (missing) notes.push(T.notes.missing(missing));
    const invalid = model.devices.filter(
      (d) => d.state && !d.state.linkError && !usable(d.state),
    ).length;
    if (invalid) notes.push(T.notes.invalid(invalid));
    const link = model.devices.filter((d) => d.state?.linkError).length;
    if (link) notes.push(T.notes.linkError(link));
    const battery = model.devices.filter((d) => d.state?.batteryLow).length;
    if (battery) notes.push(T.notes.batteryLow(battery));
    const failedStops = [...this.expectations.entries()]
      .filter(([, e]) => e.action === 'stop' && e.failed)
      .map(([serial]) => model.devices.find((d) => d.serial === serial))
      .filter(Boolean)
      .map((d) => (d.roomName ? `${d.roomName} - ${d.name}` : d.name));
    if (failedStops.length) notes.push(T.notes.stopNotApplied(failedStops));
    const devices = this.discoveredDevices();
    const ids = new Set(devices.map((d) => d.external_id));
    const created = (this.gladys.devices ?? []).filter((d) => ids.has(d.external_id)).length;
    return T.status.ok({
      serial: model.cube.serial,
      firmware: model.cube.firmware,
      devices: model.devices.length,
      rooms: model.rooms,
      created,
      notes,
    });
  }

  /** Never throws: a refusal of Gladys is not a failure of the Cube. */
  async publishDiscovered(devices = this.discoveredDevices()) {
    this.discoveredKey = JSON.stringify(devices);
    await this.gladys.publishDiscoveredDevices(devices).catch((err) => {
      this.discoveredKey = null;
      this.logger.warn(`Discovery not published: ${err.message}`);
    });
  }

  /** Discovery (scan button): what the last read gave (the Cube is never read sooner than the interval). */
  async publishDiscovery() {
    await this.publishDiscovered();
  }

  /** The states of the created devices, within the per-minute budget. Never throws. */
  async publishStates() {
    const model = this.model;
    if (!model || this.gladysAway) return;
    const states = modelStates(this.gladys, model, { duty: this.duty() });
    // Only the features the created devices have (fixed at their creation).
    const features = new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
    let list = states.filter((s) => features.has(s.device_feature_external_id));
    if (list.length === 0) return;
    const remaining = this.budget.remaining();
    if (list.length > remaining) {
      // In turn: the next cut starts where this one stopped, so no feature
      // is held back for ever (the SDK skips the unchanged ones anyway).
      this.logger.debug(`${list.length - remaining} state(s) held back (state budget)`);
      const start = this.budgetCursor % list.length;
      list = [...list.slice(start), ...list.slice(0, start)].slice(0, remaining);
      this.budgetCursor = start + remaining;
    }
    if (list.length === 0) return;
    try {
      const result = await this.gladys.publishChangedStates(list, {
        heartbeat: INTERVALS.HEARTBEAT_MS,
      });
      this.budget.record(result?.count ?? list.length);
    } catch (err) {
      this.logger.warn(`States not published: ${err.message}`);
    }
  }

  /** The badge of every created device: local while the Cube answers and gives valid values. */
  async publishTransports() {
    if (this.gladysAway) return;
    const model = this.online ? this.model : null;
    const shown = new Set(
      model
        ? [
            idsOf(this.gladys, KINDS.CUBE, model.cube.serial).device,
            ...model.devices
              .filter((d) => usable(d.state))
              .map((d) => idsOf(this.gladys, d.kind, d.serial).device),
          ]
        : [],
    );
    const entries = [];
    for (const device of this.gladys.devices ?? []) {
      const parsed = parseExternalId(this.gladys, device?.external_id);
      if (!parsed || parsed.feature !== null) continue;
      entries.push({
        external_id: device.external_id,
        transport: shown.has(device.external_id) ? 'local' : 'unreachable',
      });
    }
    const changed = entries.filter((e) => this.transports.get(e.external_id) !== e.transport);
    for (let start = 0; start < changed.length; start += TRANSPORTS_PER_CALL) {
      const batch = changed.slice(start, start + TRANSPORTS_PER_CALL);
      for (const entry of batch) this.transports.set(entry.external_id, entry.transport);
      await this.gladys.publishTransports(batch).catch((err) => {
        for (const entry of batch) this.transports.delete(entry.external_id);
        this.logger.debug(`Transports not published: ${err.message}`);
      });
    }
  }

  // --- Devices created / updated / deleted in Gladys ---------------------------------

  async deviceCreated(device) {
    const parsed = parseExternalId(this.gladys, device?.external_id);
    if (!parsed || parsed.feature !== null || !this.online) return;
    await this.publishStates();
    await this.publishTransports();
    if (this.model) await this.setStatus(true, this.okMessage());
  }

  async deviceUpdated(device) {
    this.transports.delete(device?.external_id);
    if (!parseExternalId(this.gladys, device?.external_id) || !this.online) return;
    // New features (Update in Discovery): their values right away.
    this.gladys.forgetPublishedStates?.();
    await this.publishStates();
    await this.publishTransports();
  }

  deviceDeleted(device) {
    this.transports.delete(device?.external_id);
  }

  // --- Commands ----------------------------------------------------------------------
  //
  // The stop (mode off: manual 4.5 °C, the valve closed) is protective: it
  // needs no option, no bounds and no values of the device, only its identity
  // (in the metadata of the connection), and it never waits behind a read or
  // another command: a read in flight is cut (the connection dropped, a new
  // one opened), a command not yet written is cancelled (the ones of the
  // same room arrived before the stop, and the one whose read is cut); it
  // only waits for the answer to a command already written (2 s at most).
  // It is always sent (idempotent), and checked on the follow-up reads: not
  // applied after 1 min, it is sent again, 3 times at most.
  //
  // Auto and heating need `allow_mode`, the setpoint `allow_setpoint`; both
  // are off by default and checked when the command arrives AND just before
  // it is sent. They run one after the other, each on the live values asked
  // to the Cube just before (`l:`, or the greeting of a new connection), on
  // valid values only, never on memory. Gladys waits 5 s: past 3.5 s after
  // the command arrived (monotonic clock), nothing is sent any more; once
  // sent, Gladys gets its answer at most 4.3 s after the command arrived.

  /** A command for Gladys (or a resent stop): its arrival on the monotonic clock. */
  newJob(parsed, command) {
    const job = { received: this.monotonic(), generation: this.generation, parsed, command };
    job.written = false;
    job.cancelled = false;
    return job;
  }

  setValue(device, feature, value) {
    const parsed = parseExternalId(this.gladys, feature?.external_id);
    if (!parsed?.feature) throw new Error(T.errors.unknownDevice);
    const command = this.validate(parsed, value);
    if (!this.loaded) throw new Error(T.errors.notLoaded);
    this.checkPermission(command);
    if (!this.config.cube) throw new Error(T.errors.notConfigured);
    const job = this.newJob(parsed, command);
    if (command.protective) return this.queueStop(job);
    return new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
      this.commands.push(job);
      void this.pump();
    });
  }

  /** The commands other than a stop, one after the other. */
  async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.commands.length > 0) {
        const job = this.commands.shift();
        this.active = job;
        try {
          job.resolve(await this.command(job));
        } catch (err) {
          job.reject(job.cancelled ? new Error(T.errors.cancelledByStop) : err);
        } finally {
          this.active = undefined;
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  checkPermission(command) {
    if (command.permission === 'mode' && !this.config.allowMode) {
      throw new Error(T.errors.modeDisabled);
    }
    if (command.permission === 'setpoint' && !this.config.allowSetpoint) {
      throw new Error(T.errors.setpointDisabled);
    }
  }

  /** The command a feature and a value ask for, checked before anything is read. */
  validate(parsed, value) {
    if (parsed.kind !== KINDS.THERMOSTAT && parsed.kind !== KINDS.WALL) {
      throw new Error(T.errors.unknownDevice);
    }
    switch (parsed.feature) {
      case TF.TARGET: {
        const raw =
          typeof value === 'number'
            ? value
            : typeof value === 'string' && SETPOINT_TEXT.test(value)
              ? Number(value)
              : NaN;
        if (!Number.isFinite(raw) || raw < SETPOINT.MIN || raw > SETPOINT.MAX) {
          throw new Error(T.errors.invalidSetpoint(SETPOINT.MIN, SETPOINT.MAX));
        }
        return { action: 'setpoint', value: raw, permission: 'setpoint' };
      }
      case TF.MODE: {
        const mode = typeof value === 'string' && /^[0-3]$/.test(value) ? Number(value) : value;
        if (mode === THERMOSTAT_MODE.COOLING) throw new Error(T.errors.coolingMode);
        if (mode === THERMOSTAT_MODE.OFF) {
          // Protective: no option, never blocked by one.
          return { action: 'stop', value: mode, protective: true };
        }
        if (mode !== THERMOSTAT_MODE.HEATING && mode !== THERMOSTAT_MODE.AUTO) {
          throw new Error(T.errors.invalidMode);
        }
        return {
          action: mode === THERMOSTAT_MODE.AUTO ? 'auto' : 'heating',
          value: mode,
          permission: 'mode',
        };
      }
      default:
        throw new Error(T.errors.unknownDevice);
    }
  }

  /** The configuration and the permission are still those of the command. */
  stillValid({ generation, command, cancelled }) {
    if (cancelled) throw new Error(T.errors.cancelledByStop);
    if (generation !== this.generation || !this.config.cube) {
      throw new Error(T.errors.configChanged);
    }
    this.checkPermission(command);
  }

  /** The room of a device of the model (0: none, the device alone). */
  roomOf(parsed) {
    return this.model?.devices.find((d) => d.kind === parsed.kind && d.serial === parsed.id)
      ?.roomId;
  }

  /**
   * A stop arrives: the commands of its room not yet written that arrived
   * before it are cancelled, a read in flight is cut, then it runs in the
   * stop lane.
   */
  queueStop(job) {
    const room = this.roomOf(job.parsed);
    const sameTarget = (other) =>
      room > 0 ? this.roomOf(other.parsed) === room : other.parsed.id === job.parsed.id;
    for (const other of this.commands) {
      if (sameTarget(other)) other.cancelled = true;
    }
    this.commands = this.commands.filter((other) => {
      if (!other.cancelled) return true;
      other.reject(new Error(T.errors.cancelledByStop));
      return false;
    });
    if (this.active && !this.active.written && sameTarget(this.active)) {
      this.active.cancelled = true;
    }
    this.preempt();
    const run = this.stops.then(() => this.runStop(job));
    this.stops = run.then(noop, noop);
    return run;
  }

  /** A read in flight (of the loop or of a command) is cut: the stop needs the line now. */
  preempt() {
    const connection = this.connection;
    if (!connection || connection.closed) return;
    if (connection.inFlight === 'L' || connection.stalled(TIMEOUTS.STALL, this.monotonic())) {
      if (this.active && !this.active.written) this.active.cancelled = true;
      this.logger.info('A read in flight is cut for a stop');
      this.dropConnection({ preempted: true });
    }
  }

  /** The stop: identity only, sent with priority, within its own budget. */
  async runStop(job) {
    if (job.generation !== this.generation || !this.config.cube) {
      throw new Error(T.errors.configChanged);
    }
    const deadline = job.received + COMMAND_BUDGET_MS;
    // Its turn may come after another stop: cut again what started meanwhile.
    this.preempt();
    this.uses += 1;
    let handedOff = false;
    try {
      let connection;
      try {
        const left = deadline - COMMAND_MIN_SEND_MS / 2 - this.monotonic();
        if (left < 1) throw Object.assign(new Error('late'), { kind: ERROR_KINDS.LATE });
        // An opening in progress (one client only) is waited for, within the budget.
        ({ connection } = await this.within(
          this.acquire(Math.min(TIMEOUTS.CONNECT, left)),
          left,
          'late',
        ));
      } catch (err) {
        throw refusal(T.errors.stopNotSent(err), err);
      }
      if (job.generation !== this.generation) throw new Error(T.errors.configChanged);
      const item = this.model?.devices.find(
        (d) => d.kind === job.parsed.kind && d.serial === job.parsed.id,
      );
      if (!item) throw new Error(T.errors.gone);
      const plan = {
        label: `stop of a ${item.kind}`,
        item,
        expect: { mode: MODES.MANUAL, target: OFF_TEMPERATURE },
        base64: buildTemperatureCommand({
          rfAddress: item.rfAddress,
          roomId: item.roomId,
          temperature: OFF_TEMPERATURE,
          mode: MODES.MANUAL,
        }),
      };
      handedOff = true;
      return await this.send({ connection, job, plan, deadline, priority: true });
    } finally {
      if (!handedOff) this.release();
    }
  }

  async command(job) {
    const { parsed, command } = job;
    this.stillValid(job);
    const deadline = job.received + COMMAND_BUDGET_MS;
    if (deadline - this.monotonic() < COMMAND_MIN_READ_MS) throw new Error(T.errors.tooSlow);
    this.uses += 1;
    let handedOff = false;
    try {
      // The fresh read: the greeting of a new connection, or `l:` on the one open.
      let connection;
      try {
        const left = () => deadline - COMMAND_MIN_SEND_MS - this.monotonic();
        const acquired = await this.acquire(Math.min(TIMEOUTS.CONNECT, left()));
        connection = acquired.connection;
        if (job.cancelled) throw new Error(T.errors.cancelledByStop);
        if (!acquired.opened) {
          const entries = await connection.requestList(Math.min(TIMEOUTS.LIST, left()));
          if (connection !== this.connection) throw new Error(T.errors.configChanged);
          this.applyList(this.model, entries);
        }
      } catch (err) {
        if (job.cancelled) throw new Error(T.errors.cancelledByStop, { cause: err });
        if (err?.message === T.errors.configChanged) throw err;
        throw refusal(T.errors.unknownState(err), err);
      }
      this.stillValid(job);
      if (this.online) void this.publishStates();
      const plan = this.plan(parsed, command);
      if (plan.already) return;
      // The radio budget of the Cube: a command it would hold for up to an hour is not sent.
      const duty = this.duty();
      if (duty && (duty.dutyCycle >= DUTY_CYCLE_REFUSE || duty.freeSlots === 0)) {
        throw new Error(T.errors.radioLow(duty.dutyCycle));
      }
      if (deadline - this.monotonic() < COMMAND_MIN_SEND_MS) throw new Error(T.errors.tooSlow);
      // The last check before acting: the user may have changed things meanwhile.
      this.stillValid(job);
      handedOff = true;
      return await this.send({ connection, job, plan, deadline });
    } finally {
      if (!handedOff) this.release();
    }
  }

  /** The thermostats of the room of `item` (the command goes to the whole room), `item` first. */
  roomDevices(item) {
    if (!(item.roomId > 0)) return [item];
    const others = this.model.devices.filter(
      (d) =>
        d !== item &&
        d.roomId === item.roomId &&
        (d.kind === KINDS.THERMOSTAT || d.kind === KINDS.WALL),
    );
    return [item, ...others];
  }

  /** What to send, decided on the fresh read only: { already } or { label, base64, expect }. */
  plan(parsed, command) {
    const item = this.model?.devices.find((d) => d.kind === parsed.kind && d.serial === parsed.id);
    if (!item) throw new Error(T.errors.gone);
    const state = item.state;
    if (!state || state.target === undefined) throw new Error(T.errors.notHeard);
    if (!usable(state)) throw new Error(T.errors.notUsable);
    const room = this.roomDevices(item);
    // Bounds: those of every thermostat of the room (the room follows the command).
    let bounds = { min: SETPOINT.MIN, max: SETPOINT.MAX };
    for (const d of room) {
      const own = setpointBounds(d.config);
      if (!own) throw new Error(T.errors.badBounds);
      bounds = { min: Math.max(bounds.min, own.min), max: Math.min(bounds.max, own.max) };
    }
    if (bounds.min > bounds.max) throw new Error(T.errors.badBounds);
    // "Already": only when every thermostat of the room shows it on valid values.
    const already = (expect) => room.every((d) => applied(expect, d.state));
    const build = (temperature, mode) => ({
      label: `${command.action} of a ${parsed.kind}`,
      item,
      expect: { mode, target: temperature },
      base64: buildTemperatureCommand({
        rfAddress: item.rfAddress,
        roomId: item.roomId,
        temperature,
        mode,
      }),
    });
    const isOff = state.mode === MODES.MANUAL && state.target <= OFF_TEMPERATURE;
    switch (command.action) {
      case 'setpoint': {
        // A setpoint on a thermostat that is off starts it again: a mode command.
        if (isOff && !this.config.allowMode) throw new Error(T.errors.offNeedsMode);
        // Half degrees: the resolution of the thermostat; the bounds are
        // checked on the value asked and on the rounded one, never clamped.
        const temperature = Math.round(command.value * 2) / 2;
        if (
          command.value < bounds.min ||
          command.value > bounds.max ||
          temperature < bounds.min ||
          temperature > bounds.max
        ) {
          throw new Error(T.errors.invalidSetpoint(bounds.min, bounds.max));
        }
        // In auto: the setpoint until the next switch point of the programme;
        // otherwise manual (a boost or a vacation ends).
        const mode = state.mode === MODES.AUTO ? MODES.AUTO : MODES.MANUAL;
        if (already({ mode, target: temperature })) return { already: true };
        return build(temperature, mode);
      }
      case 'auto':
        if (already({ mode: MODES.AUTO, target: 0 })) return { already: true };
        return build(0, MODES.AUTO);
      case 'heating': {
        // Manual at the current setpoint, or at the comfort temperature of
        // the device when the valve is closed.
        let temperature = state.target;
        if (!(temperature >= bounds.min && temperature <= bounds.max)) {
          const comfort = item.config?.comfort;
          if (!(comfort >= bounds.min && comfort <= bounds.max)) {
            throw new Error(T.errors.noComfort);
          }
          temperature = comfort;
        }
        if (already({ mode: MODES.MANUAL, target: temperature })) return { already: true };
        return build(temperature, MODES.MANUAL);
      }
      default:
        throw new Error(T.errors.unknownDevice);
    }
  }

  /**
   * Send, then answer Gladys on the Cube's answer or at COMMAND_ACK_MS after
   * the arrival (monotonic), whichever first. Once it may have left, the
   * follow-up reads check it on the device.
   */
  async send({ connection, job, plan, deadline, priority = false }) {
    let writtenAt;
    const request = connection.send(plan.base64, TIMEOUTS.SEND, {
      priority,
      beforeSend: () => {
        if (job.cancelled) throw new Error(T.errors.cancelledByStop);
        if (job.generation !== this.generation || !this.config.cube) {
          throw new Error(T.errors.configChanged);
        }
        if (!job.command.protective) this.checkPermission(job.command);
        const mono = this.monotonic();
        if (mono > deadline) throw Object.assign(new Error('too late'), { kind: ERROR_KINDS.LATE });
        writtenAt = mono;
        job.written = true;
      },
    });
    this.releaseAfter(request);
    let handle;
    const ack = new Promise((resolve) => {
      handle = this.timers.setTimeout(
        resolve,
        Math.max(0, job.received + COMMAND_ACK_MS - this.monotonic()),
      );
    });
    const outcome = await Promise.race([
      request.then(
        (answer) => ({ done: true, answer }),
        (err) => ({ err }),
      ),
      ack.then(() => ({ pending: true })),
    ]);
    this.timers.clearTimeout(handle);
    if (writtenAt !== undefined && job.generation === this.generation) {
      // A new command for this device replaces what was expected of the last one.
      this.expectations.set(plan.item.serial, {
        kind: plan.item.kind,
        action: job.command.action,
        ...plan.expect,
        sentAt: writtenAt,
        resends: 0,
        failed: false,
      });
      this.addFollowUps(writtenAt);
    }
    if (outcome.done) {
      this.noteAnswer(outcome.answer);
      const { dutyCycle, freeSlots } = outcome.answer;
      if (dutyCycle >= 100 || freeSlots === 0) {
        this.logger.warn(`${plan.label} queued by the Cube (radio budget)`);
        throw new Error(T.errors.queued);
      }
      this.logger.info(`${plan.label} accepted by the Cube`);
      return;
    }
    if (outcome.pending) {
      request.then(
        (answer) => this.noteAnswer(answer),
        (err) => {
          this.noteAnswer(err?.answer);
          this.logger.warn(`${plan.label} not confirmed: ${err?.kind ?? 'error'}`);
        },
      );
      if (writtenAt === undefined) throw new Error(T.errors.notSent({ kind: ERROR_KINDS.TIMEOUT }));
      this.logger.info(`${plan.label} sent, the Cube has not answered yet`);
      throw new Error(T.errors.unconfirmed({ kind: ERROR_KINDS.TIMEOUT }));
    }
    const { err } = outcome;
    if (job.cancelled && writtenAt === undefined) throw new Error(T.errors.cancelledByStop);
    if (err?.message === T.errors.configChanged) throw err;
    if (err?.notSent || writtenAt === undefined) throw refusal(T.errors.notSent(err), err);
    if (err?.kind === ERROR_KINDS.REJECTED) {
      this.noteAnswer(err.answer);
      throw refusal(T.errors.rejected, err);
    }
    throw refusal(T.errors.unconfirmed(err), err);
  }

  // --- Configuration screen button ----------------------------------------------------

  /** Resolves `promise`, or rejects with `message` after `ms`. */
  within(promise, ms, message) {
    let handle;
    const limit = new Promise((_, reject) => {
      handle = this.timers.setTimeout(
        () => reject(Object.assign(new Error(message), { kind: ERROR_KINDS.TIMEOUT })),
        ms,
      );
    });
    return Promise.race([promise, limit]).finally(() => this.timers.clearTimeout(handle));
  }

  /**
   * "Test the connection": reads the Cube now when a read is due (never
   * sooner than the interval), then reports, within 25 s.
   */
  async testConnection() {
    // The configuration as saved now (the one in memory if Gladys cannot give it).
    const raw = await this.gladys.getConfig().catch(() => this.rawConfig);
    const key = JSON.stringify(normalizeConfig(raw));
    try {
      if (key !== this.configKey) {
        await this.within(this.start(raw), INTERVALS.TEST_MS, T.errors.testTooLong);
      }
      if (this.config.cube) {
        // The interval is respected (never a read sooner than a minute after
        // the last one), the retry pause is not: the user asked.
        const mono = this.monotonic();
        const due = this.earliestAt(mono);
        if (due > mono) {
          if (!this.online || !this.model) return this.wantedStatus?.[1] ?? T.test.slow;
          return T.test.notDue(due - mono);
        }
        this.halt();
        const generation = this.generation;
        const epoch = this.epoch;
        await this.within(
          this.read(generation, epoch, { now: true }),
          INTERVALS.TEST_MS,
          T.errors.testTooLong,
        );
        if (this.current(generation, epoch)) this.schedule();
      }
    } catch {
      if (this.config.cube && !this.timer) this.schedule();
      return T.test.slow;
    }
    if (!this.online || !this.model) {
      return (
        this.wantedStatus?.[1] ?? {
          en: T.errors.notConfigured,
          fr: 'L’adresse du Cube n’est pas saisie',
        }
      );
    }
    const count = (kind) => this.model.devices.filter((d) => d.kind === kind).length;
    return T.test.ok({
      serial: this.model.cube.serial,
      firmware: this.model.cube.firmware,
      thermostats: count(KINDS.THERMOSTAT),
      walls: count(KINDS.WALL),
      windows: count(KINDS.WINDOW),
      missing: this.model.devices.filter((d) => !d.state).length,
    });
  }
}
