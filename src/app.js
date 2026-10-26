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
//                  retry 1 to 10 min later. Never sooner than the interval,
//                  a restart included (the time of the last attempt is kept
//                  in /data).
//   setValue       the commands, see "Commands" below.
//
// One loop, one timer: halt() bumps an epoch, and a run of an older epoch
// never schedules itself again. The created devices are read from
// `gladys.devices`, which the SDK keeps up to date: never a copy of our own.
// Two clocks: `now` (wall clock) dates /data; `monotonic` paces every delay.
// Each decision reads the monotonic clock once and hands the instant on
// (dueAt(mono)): a real clock moves between two reads of it.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { Budget } from './budget.js';
import { normalizeConfig } from './config.js';
import {
  COMMAND_ACK_MS,
  COMMAND_BUDGET_MS,
  COMMAND_MIN_READ_MS,
  COMMAND_MIN_SEND_MS,
  DUTY_CYCLE_WARNING,
  INTERVALS,
  KINDS,
  READ_AFTER_COMMAND_MS,
  SERIAL,
  SETPOINT,
  STATES_PER_MINUTE,
  THERMOSTAT_FEATURES as TF,
  TIMEOUTS,
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
    this.budget = new Budget({ perMinute: STATES_PER_MINUTE, now });
    this.budgetCursor = 0;
    this.rawConfig = {};
    this.config = normalizeConfig();
    this.configKey = null;
    this.connection = null;
    this.opening = null;
    this.generation = 0;
    this.epoch = 0;
    this.timer = undefined;
    this.queue = Promise.resolve();
    /** The commands waiting: a stop (mode off) goes first. */
    this.commands = [];
    this.pumping = false;
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
    this.followUpAt = undefined;
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

  dropConnection({ quit = false } = {}) {
    const connection = this.connection;
    this.connection = null;
    connection?.close({ quit });
  }

  async run(rawConfig) {
    const config = normalizeConfig(rawConfig);
    const key = JSON.stringify(config);
    this.gladysAway = false;
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
    if (this.followUpAt !== undefined) due = Math.min(due, this.followUpAt);
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

  /**
   * One round of the reading loop. Never throws. `now`: the test button,
   * which only waits for the interval, not for the retry pause.
   */
  async read(generation, epoch, { now = false } = {}) {
    if (!this.config.cube || !this.current(generation, epoch)) return;
    const mono = this.monotonic();
    if (mono < (now ? this.earliestAt(mono) : this.dueAt(mono))) return;
    this.lastReadAt = mono;
    this.followUpAt = undefined;
    await this.saveAttempt(this.now());
    if (!this.current(generation, epoch)) return;
    try {
      await this.fetch(generation, mono);
    } catch (err) {
      if (this.current(generation, epoch)) await this.failed(err, mono);
      return;
    }
    if (!this.current(generation, epoch)) return;
    await this.succeeded();
  }

  /** The Cube read: a new connection and its greeting, or `l:` on the one kept. */
  async fetch(generation, mono) {
    let connection = this.connection;
    if (
      connection &&
      !connection.closed &&
      this.config.keepConnection &&
      mono - this.connectedAt >= INTERVALS.RECONNECT_MS
    ) {
      // Fresh rooms, names and configurations now and then.
      this.dropConnection({ quit: true });
      connection = null;
    }
    if (!connection || connection.closed) {
      const opened = await this.open(TIMEOUTS.CONNECT);
      if (generation !== this.generation) return;
      this.model = this.buildModel(opened.greeting);
    } else {
      const entries = await connection.requestList(TIMEOUTS.LIST);
      if (generation !== this.generation || connection !== this.connection) return;
      this.applyList(this.model, entries);
    }
    if (!this.config.keepConnection) this.dropConnection({ quit: true });
  }

  /**
   * Opens the one connection (the Cube accepts a single client): a second
   * caller waits for the opening in progress. -> { connection, greeting }.
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
      opened.connection.onPush = (entries) => this.pushed(opened.connection, entries);
      this.connection = opened.connection;
      this.connectedAt = this.monotonic();
      return opened;
    })();
    return this.opening;
  }

  /** The Cube sent an L on its own (a device reported): published at once. */
  pushed(connection, entries) {
    if (connection !== this.connection || !this.model || !this.online || this.gladysAway) return;
    this.applyList(this.model, entries);
    void this.publishStates();
  }

  /** The greeting -> the model: the Cube, its rooms and devices with their configuration and values. */
  buildModel(greeting) {
    const { hello, metadata, configs, list } = greeting;
    if (!hello) {
      throw Object.assign(new Error('no hello'), { kind: ERROR_KINDS.PROTOCOL, notSent: true });
    }
    const rooms = new Map(metadata.rooms.map((room) => [room.id, room.name]));
    const seen = new Set();
    const devices = [];
    let dropped = 0;
    for (const item of metadata.devices) {
      const kind = kindOf(item.type);
      if (!kind) continue;
      if (!SERIAL.test(item.serial) || seen.has(item.serial)) {
        dropped += 1;
        continue;
      }
      seen.add(item.serial);
      const config = configs.get(item.rfAddress);
      devices.push({
        kind,
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
    if (dropped) this.logger.warn(`${dropped} device(s) without a usable serial number ignored`);
    const model = {
      cube: {
        serial: hello.serial,
        firmware: hello.firmware,
        dutyCycle: hello.dutyCycle,
        freeSlots: hello.freeSlots,
      },
      rooms: rooms.size,
      devices,
    };
    this.applyList(model, list);
    return model;
  }

  /** The live values of an L message applied to the devices of the model. */
  applyList(model, entries) {
    if (!model) return;
    const byRf = new Map(entries.map((entry) => [entry.rfAddress, entry]));
    for (const item of model.devices) {
      const entry = byRf.get(item.rfAddress);
      item.state = entry ? deviceState(entry, item.type) : undefined;
    }
  }

  /** A reading failed: a retry with a growing delay, never sooner than the interval. */
  async failed(err, mono) {
    const wasOnline = this.online;
    this.online = false;
    this.dropConnection();
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

  async succeeded() {
    this.online = true;
    this.retryDelay = INTERVALS.RETRY_MIN_MS;
    this.nextTryAt = undefined;
    const devices = this.discoveredDevices();
    const key = JSON.stringify(devices);
    if (key !== this.discoveredKey) await this.publishDiscovered(devices);
    await this.publishStates();
    await this.publishTransports();
    await this.setStatus(true, this.okMessage());
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
    if (Number.isFinite(model.cube.dutyCycle) && model.cube.dutyCycle >= DUTY_CYCLE_WARNING) {
      notes.push(T.notes.dutyCycle(model.cube.dutyCycle));
    }
    const missing = model.devices.filter((d) => !d.state).length;
    if (missing) notes.push(T.notes.missing(missing));
    const battery = model.devices.filter((d) => d.state?.batteryLow).length;
    if (battery) notes.push(T.notes.batteryLow(battery));
    const link = model.devices.filter((d) => d.state?.linkError).length;
    if (link) notes.push(T.notes.linkError(link));
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
    const states = modelStates(this.gladys, model);
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

  /** The badge of every created device: local while the Cube answers and lists it. */
  async publishTransports() {
    if (this.gladysAway) return;
    const model = this.online ? this.model : null;
    const shown = new Set(
      model
        ? [
            idsOf(this.gladys, KINDS.CUBE, model.cube.serial).device,
            ...model.devices
              .filter((d) => d.state)
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
  // The setpoint needs `allow_setpoint`, the mode `allow_mode`; both are off
  // by default and checked when the command arrives AND just before it is
  // sent. The value is checked strictly (null, '' and true are not numbers).
  // The commands run one after the other (one Cube, one connection): a stop
  // (mode off: the valve closed) goes before the others, and drops a
  // connection that no longer answers so as to use a new one. Each command
  // asks the Cube for its live values just before acting (`l:`, its cache)
  // and decides on that read only, never on memory: a device gone, a device
  // the Cube has not heard, a read that fails, and nothing is sent; the
  // value already there, and nothing is sent either. Gladys waits 5 s: past
  // 3.5 s after the command arrived, nothing is sent any more; once sent,
  // Gladys gets its answer at most 4.3 s after the command, and a command
  // that may have left is never told "not sent". The S answer of the Cube
  // says it accepted the command for the radio; the thermostat applies it
  // when it next listens: the next read shows the value the Cube holds.

  setValue(device, feature, value) {
    const received = this.now();
    const parsed = parseExternalId(this.gladys, feature?.external_id);
    if (!parsed?.feature) throw new Error(T.errors.unknownDevice);
    const command = this.validate(parsed, value);
    this.checkPermission(command);
    if (!this.config.cube) throw new Error(T.errors.notConfigured);
    const generation = this.generation;
    const job = { received, generation, parsed, command };
    job.promise = new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
    });
    if (command.protective) {
      this.commands.unshift(job);
      // A connection that no longer answers is not waited for by a stop.
      if (this.connection?.stalled(TIMEOUTS.STALL, this.monotonic())) {
        this.logger.warn('The Cube does not answer: the connection is dropped for the stop');
        this.dropConnection();
      }
    } else {
      this.commands.push(job);
    }
    void this.pump();
    return job.promise;
  }

  /** The commands, one after the other. */
  async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.commands.length > 0) {
        const job = this.commands.shift();
        try {
          job.resolve(await this.command(job));
        } catch (err) {
          job.reject(err);
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
        if (
          mode !== THERMOSTAT_MODE.OFF &&
          mode !== THERMOSTAT_MODE.HEATING &&
          mode !== THERMOSTAT_MODE.AUTO
        ) {
          throw new Error(T.errors.invalidMode);
        }
        return {
          action: 'mode',
          value: mode,
          permission: 'mode',
          protective: mode === THERMOSTAT_MODE.OFF,
        };
      }
      default:
        throw new Error(T.errors.unknownDevice);
    }
  }

  /** The configuration and the permission are still those of the command. */
  stillValid({ generation, command }) {
    if (generation !== this.generation || !this.config.cube) {
      throw new Error(T.errors.configChanged);
    }
    this.checkPermission(command);
  }

  async command(job) {
    const { received, parsed, command } = job;
    this.stillValid(job);
    const deadline = received + COMMAND_BUDGET_MS;
    if (deadline - this.now() < COMMAND_MIN_READ_MS) throw new Error(T.errors.tooSlow);
    // The fresh read: the greeting of a new connection, or `l:` on the one kept.
    let connection;
    try {
      const left = deadline - COMMAND_MIN_SEND_MS - this.now();
      if (this.connection && !this.connection.closed) {
        connection = this.connection;
        const entries = await connection.requestList(Math.min(TIMEOUTS.LIST, left));
        if (connection !== this.connection) throw new Error(T.errors.configChanged);
        this.applyList(this.model, entries);
      } else {
        const opened = await this.open(Math.min(TIMEOUTS.CONNECT, left));
        connection = opened.connection;
        this.stillValid(job);
        this.model = this.buildModel(opened.greeting);
      }
    } catch (err) {
      if (err?.message === T.errors.configChanged) throw err;
      throw new Error(T.errors.unknownState(err), { cause: err });
    }
    if (this.online) void this.publishStates();
    const plan = this.plan(parsed, command);
    if (plan.already) {
      this.release();
      return;
    }
    if (deadline - this.now() < COMMAND_MIN_SEND_MS) {
      this.release();
      throw new Error(T.errors.tooSlow);
    }
    // The last check before acting: the user may have changed things meanwhile.
    this.stillValid(job);
    await this.send({ connection, job, plan, deadline });
  }

  /** What to send, decided on the fresh read only: { already } or { label, base64 }. */
  plan(parsed, command) {
    const item = this.model?.devices.find((d) => d.kind === parsed.kind && d.serial === parsed.id);
    if (!item) throw new Error(T.errors.gone);
    const state = item.state;
    if (!state || state.target === undefined || state.target <= 0) {
      throw new Error(T.errors.notHeard);
    }
    const bounds = setpointBounds(item.config);
    if (!bounds) throw new Error(T.errors.badBounds);
    const build = (temperature, mode) => ({
      label: `${command.action} of ${parsed.kind} ${parsed.id}`,
      base64: buildTemperatureCommand({
        rfAddress: item.rfAddress,
        roomId: item.roomId,
        temperature,
        mode,
      }),
    });
    const manual = state.mode === MODES.MANUAL;
    switch (command.action) {
      case 'setpoint': {
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
        if (state.target === temperature && (mode === MODES.AUTO || manual)) {
          return { already: true };
        }
        return build(temperature, mode);
      }
      case 'mode': {
        if (command.value === THERMOSTAT_MODE.AUTO) {
          if (state.mode === MODES.AUTO) return { already: true };
          return build(0, MODES.AUTO);
        }
        if (command.value === THERMOSTAT_MODE.OFF) {
          if (manual && state.target <= OFF_TEMPERATURE) return { already: true };
          return build(OFF_TEMPERATURE, MODES.MANUAL);
        }
        // Heating: manual at the current setpoint, or at the comfort
        // temperature of the device when the valve is closed.
        if (manual && state.target >= bounds.min) return { already: true };
        let temperature = state.target;
        if (!(temperature >= bounds.min && temperature <= bounds.max)) {
          const comfort = item.config?.comfort;
          if (!(comfort >= bounds.min && comfort <= bounds.max)) {
            throw new Error(T.errors.noComfort);
          }
          temperature = comfort;
        }
        return build(temperature, MODES.MANUAL);
      }
      default:
        throw new Error(T.errors.unknownDevice);
    }
  }

  /**
   * Send, then answer Gladys on the Cube's answer or at COMMAND_ACK_MS,
   * whichever first. Whatever the outcome once it may have left, the Cube is
   * read again soon to show what it holds.
   */
  async send({ connection, job, plan, deadline }) {
    let sent = false;
    const request = connection.send(plan.base64, TIMEOUTS.SEND, {
      beforeSend: () => {
        this.stillValid(job);
        if (this.now() > deadline) {
          throw Object.assign(new Error('too late'), { kind: ERROR_KINDS.LATE });
        }
        sent = true;
      },
    });
    let handle;
    const ack = new Promise((resolve) => {
      handle = this.timers.setTimeout(
        resolve,
        Math.max(0, job.received + COMMAND_ACK_MS - this.now()),
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
    if (sent && job.generation === this.generation) this.readSoon();
    if (outcome.done) {
      if (this.model) {
        this.model.cube.dutyCycle = outcome.answer.dutyCycle;
        this.model.cube.freeSlots = outcome.answer.freeSlots;
      }
      this.logger.info(`${plan.label} accepted by the Cube`);
      this.release(request);
      return;
    }
    if (outcome.pending) {
      // Sent, the Cube still at work: Gladys is told exactly that.
      request.catch((err) =>
        this.logger.warn(`${plan.label} not confirmed: ${err?.kind ?? 'error'}`),
      );
      this.release(request);
      this.logger.info(`${plan.label} sent, the Cube has not answered yet`);
      if (!sent) throw new Error(T.errors.notSent({ kind: ERROR_KINDS.TIMEOUT }));
      throw new Error(T.errors.unconfirmed({ kind: ERROR_KINDS.TIMEOUT }));
    }
    const { err } = outcome;
    this.release(request);
    if (err?.notSent || !sent) throw new Error(T.errors.notSent(err), { cause: err });
    if (err?.kind === ERROR_KINDS.REJECTED) {
      if (this.model && err.answer) {
        this.model.cube.dutyCycle = err.answer.dutyCycle;
        this.model.cube.freeSlots = err.answer.freeSlots;
      }
      throw new Error(T.errors.rejected, { cause: err });
    }
    throw new Error(T.errors.unconfirmed(err), { cause: err });
  }

  /** With `keep_connection` off, the connection is closed once the exchange in flight ends. */
  release(request = Promise.resolve()) {
    if (this.config.keepConnection) return;
    const connection = this.connection;
    request.then(noop, noop).then(() => {
      if (this.connection === connection) this.dropConnection({ quit: true });
    });
  }

  /** Read the Cube again soon (after a command): the loop restarts from there. */
  readSoon() {
    if (!this.config.cube) return;
    const mono = this.monotonic();
    this.followUpAt = mono + READ_AFTER_COMMAND_MS;
    this.nextTryAt = undefined;
    if (!this.gladysAway) this.schedule(mono);
  }

  // --- Configuration screen button ----------------------------------------------------

  /** Resolves `promise`, or rejects with `message` after `ms`. */
  within(promise, ms, message) {
    let handle;
    const limit = new Promise((_, reject) => {
      handle = this.timers.setTimeout(() => reject(new Error(message)), ms);
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
