// -----------------------------------------------------------------------------
// The Gladys devices of a MAX! Cube and their states. Pure.
//
//   cube        `cube:<cube serial>`      radio duty cycle, free command slots
//   thermostat  `thermostat:<serial>`     radiator thermostat: temperature (when
//                                         the Cube gives one), setpoint, mode,
//                                         MAX! mode, heating state, valve, battery, link
//   wall        `wall:<serial>`           wall thermostat: temperature, setpoint,
//                                         mode, MAX! mode, battery, link
//   window      `window:<serial>`         window contact: open / closed, battery, link
//
// The ids are the serial numbers printed on the devices, stable for ever:
// a new address of the Cube, a new room or a new name keeps every device.
//
// Commands (checked again at each command, src/app.js): the setpoint
// (thermostat / target-temperature, 5-30 °C by half degrees within the bounds
// of the device) behind `allow_setpoint`, the mode (thermostat / mode: off,
// heating, auto) behind `allow_mode`. Everything else is read only.
//
// A device republished never loses a feature of the one the user created,
// and keeps the shape (category, type, unit, bounds, read_only) of its
// features: a difference would show "Update" in Discovery, and updating would
// drop history (mergeWithCreated, from gladys-plugwise).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import {
  CUBE_FEATURES as CF,
  KINDS,
  SERIAL,
  SETPOINT,
  THERMOSTAT_FEATURES as TF,
  WINDOW_FEATURES as WF,
} from './constants.js';
import { MODES, MODE_NAMES, OFF_TEMPERATURE, usable } from './cube/protocol.js';
import { texts } from './i18n.js';

export const idsOf = (gladys, kind, id) => gladys.externalIds(kind, id);

/** Gladys THERMOSTAT_MODE (server/utils/constants.js). */
export const THERMOSTAT_MODE = Object.freeze({ OFF: 0, HEATING: 1, COOLING: 2, AUTO: 3 });
/** Gladys THERMOSTAT_OPERATING_STATE. */
export const OPERATING_STATE = Object.freeze({ IDLE: 0, HEATING: 1 });
/** Gladys OPENING_SENSOR_STATE: 1 is closed, 0 is open. */
export const OPENING = Object.freeze({ OPEN: 0, CLOSE: 1 });

const base = (extra) => ({
  read_only: true,
  has_feedback: false,
  keep_history: true,
  min: 0,
  max: 100,
  ...extra,
});
const plain = (extra) => base({ category: C.UNKNOWN, type: T.SENSOR.DECIMAL, ...extra });
const flag = (category) => base({ category, type: T.SENSOR.BINARY, max: 1 });
const temperature = () =>
  base({
    category: C.TEMPERATURE_SENSOR,
    type: T.SENSOR.DECIMAL,
    unit: U.CELSIUS,
    min: -50,
    max: 150,
  });
const words = () =>
  base({ category: C.TEXT, type: T.TEXT.TEXT, min: 0, max: 0, keep_history: false });

/**
 * The setpoint bounds a command accepts for a device: 5-30 °C narrowed to
 * the min / max the Cube gives (its 4.5 "off" and 30.5 "on" stay out).
 * Bounds that leave nothing: undefined (nothing is sent).
 */
export function setpointBounds(config) {
  const min = Math.max(
    SETPOINT.MIN,
    Number.isFinite(config?.min) ? Math.ceil(config.min * 2) / 2 : SETPOINT.MIN,
  );
  const max = Math.min(
    SETPOINT.MAX,
    Number.isFinite(config?.max) ? Math.floor(config.max * 2) / 2 : SETPOINT.MAX,
  );
  return min <= max ? { min, max } : undefined;
}

function device(gladys, kind, id, name, model, list, t) {
  const ids = idsOf(gladys, kind, id);
  return {
    name,
    external_id: ids.device,
    model,
    should_poll: false,
    features: list.map(([key, feature]) => ({
      name: t.features[key],
      external_id: ids.feature(key),
      ...feature,
    })),
  };
}

export function cubeDevice(gladys, cube, t) {
  return device(
    gladys,
    KINDS.CUBE,
    cube.serial,
    t.cube(cube.serial),
    'eQ-3 MAX! Cube',
    [
      [CF.DUTY_CYCLE, plain({ keep_history: false })],
      [CF.FREE_SLOTS, plain({ type: T.SENSOR.INTEGER, max: 255, keep_history: false })],
    ],
    t,
  );
}

/** The features common to the thermostats: setpoint, modes, battery, link. */
function thermostatFeatures(config) {
  const bounds = setpointBounds(config) ?? { min: SETPOINT.MIN, max: SETPOINT.MAX };
  return [
    [
      TF.TARGET,
      base({
        category: C.THERMOSTAT,
        type: T.THERMOSTAT.TARGET_TEMPERATURE,
        unit: U.CELSIUS,
        // The off setpoint (4.5 °C) is shown, never commanded.
        min: Math.min(bounds.min, OFF_TEMPERATURE),
        max: bounds.max,
        read_only: false,
        has_feedback: true,
      }),
    ],
    [
      TF.MODE,
      base({
        category: C.THERMOSTAT,
        type: T.THERMOSTAT.MODE,
        max: 3,
        read_only: false,
        has_feedback: true,
      }),
    ],
    [TF.MAX_MODE, words()],
    [TF.BATTERY_LOW, flag(C.BATTERY_LOW)],
    [TF.LINK_ERROR, flag(C.UNKNOWN)],
  ];
}

const displayName = (item) => (item.roomName ? `${item.roomName} - ${item.name}` : item.name);

export function thermostatDevice(gladys, item, t) {
  const list = [
    [TF.TEMPERATURE, temperature()],
    ...thermostatFeatures(item.config),
    [TF.OPERATING, base({ category: C.THERMOSTAT, type: T.THERMOSTAT.OPERATING_STATE, max: 1 })],
    [TF.VALVE, plain()],
  ];
  return device(
    gladys,
    KINDS.THERMOSTAT,
    item.serial,
    t.thermostat(displayName(item)),
    'eQ-3 MAX! radiator thermostat',
    list,
    t,
  );
}

export function wallDevice(gladys, item, t) {
  const list = [[TF.TEMPERATURE, temperature()], ...thermostatFeatures(item.config)];
  return device(
    gladys,
    KINDS.WALL,
    item.serial,
    t.wall(displayName(item)),
    'eQ-3 MAX! wall thermostat',
    list,
    t,
  );
}

export function windowDevice(gladys, item, t) {
  const list = [
    [WF.CONTACT, flag(C.OPENING_SENSOR)],
    [WF.BATTERY_LOW, flag(C.BATTERY_LOW)],
    [WF.LINK_ERROR, flag(C.UNKNOWN)],
  ];
  return device(
    gladys,
    KINDS.WINDOW,
    item.serial,
    t.window(displayName(item)),
    'eQ-3 MAX! window contact',
    list,
    t,
  );
}

const SHAPE = ['category', 'type', 'unit', 'min', 'max', 'read_only'];

/**
 * The device as published, never with fewer features than the created one,
 * nor a different shape for a feature it already has.
 */
export function mergeWithCreated(built, created) {
  if (!created?.features?.length) return built;
  const existing = new Map(created.features.map((f) => [f.external_id, f]));
  const features = built.features.map((feature) => {
    const kept = existing.get(feature.external_id);
    if (!kept) return feature;
    const shaped = { ...feature };
    for (const key of SHAPE) {
      if (kept[key] === undefined || kept[key] === null) delete shaped[key];
      else shaped[key] = kept[key];
    }
    return shaped;
  });
  const ids = new Set(features.map((f) => f.external_id));
  for (const kept of created.features) {
    if (ids.has(kept.external_id)) continue;
    const copy = {
      name: kept.name,
      external_id: kept.external_id,
      has_feedback: kept.has_feedback ?? false,
      keep_history: kept.keep_history ?? true,
    };
    for (const key of SHAPE)
      if (kept[key] !== undefined && kept[key] !== null) copy[key] = kept[key];
    if (Array.isArray(kept.supported_options)) copy.supported_options = kept.supported_options;
    features.push(copy);
  }
  return { ...built, features };
}

/** Every device a Cube shows, merged with the created ones. */
export function buildDevices(gladys, model, language, createdList = gladys.devices ?? []) {
  const t = texts(language);
  const created = new Map(createdList.map((d) => [d.external_id, d]));
  const built = [cubeDevice(gladys, model.cube, t)];
  for (const item of model.devices) {
    if (item.kind === KINDS.THERMOSTAT) built.push(thermostatDevice(gladys, item, t));
    else if (item.kind === KINDS.WALL) built.push(wallDevice(gladys, item, t));
    else if (item.kind === KINDS.WINDOW) built.push(windowDevice(gladys, item, t));
  }
  return built.map((d) => mergeWithCreated(d, created.get(d.external_id)));
}

/**
 * What a device or feature external id of this integration designates:
 * { kind, id, feature } (feature null for a device), or null.
 */
export function parseExternalId(gladys, externalId) {
  if (typeof externalId !== 'string') return null;
  for (const kind of Object.values(KINDS)) {
    const prefix = gladys.externalId(`${kind}:`);
    if (!externalId.startsWith(prefix)) continue;
    const [id, feature, ...rest] = externalId.slice(prefix.length).split(':');
    if (rest.length > 0 || !SERIAL.test(id ?? '')) return null;
    return { kind, id, feature: feature ?? null };
  }
  return null;
}

// --- States --------------------------------------------------------------------------

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const bit = (value) => (value === undefined ? undefined : value ? 1 : 0);

/** The Gladys mode of a thermostat state: auto, else heating, or off when the valve is closed. */
export function gladysModeOf(state) {
  if (!state || state.mode === undefined) return undefined;
  if (state.mode === MODES.AUTO) return THERMOSTAT_MODE.AUTO;
  if (isNumber(state.target) && state.target <= OFF_TEMPERATURE) return THERMOSTAT_MODE.OFF;
  return THERMOSTAT_MODE.HEATING;
}

/** A list of states built with `add(id, value)`: numbers as given, strings as text, undefined skipped. */
function collector() {
  const states = [];
  const add = (id, value) => {
    if (typeof value === 'string') {
      states.push({ device_feature_external_id: id, text: value });
    } else if (isNumber(value)) {
      states.push({ device_feature_external_id: id, state: value });
    }
  };
  return { states, add };
}

/**
 * The states of every device of the model: the Cube (its duty cycle while
 * fresh: `duty`), then each device the last list gave. Values only from a
 * valid, initialized entry without a radio link error; the battery and the
 * link flags always.
 */
export function modelStates(gladys, model, { duty } = {}) {
  const { states, add } = collector();
  const cube = idsOf(gladys, KINDS.CUBE, model.cube.serial);
  add(cube.feature(CF.DUTY_CYCLE), duty?.dutyCycle);
  add(cube.feature(CF.FREE_SLOTS), duty?.freeSlots);
  for (const item of model.devices) {
    const state = item.state;
    if (!state) continue;
    const ids = idsOf(gladys, item.kind, item.serial);
    const flags = item.kind === KINDS.WINDOW ? WF : TF;
    add(ids.feature(flags.BATTERY_LOW), bit(state.batteryLow));
    add(ids.feature(flags.LINK_ERROR), bit(state.linkError));
    if (!usable(state)) continue;
    if (item.kind === KINDS.WINDOW) {
      add(ids.feature(WF.CONTACT), state.open ? OPENING.OPEN : OPENING.CLOSE);
      continue;
    }
    add(ids.feature(TF.TEMPERATURE), state.temperature);
    add(ids.feature(TF.TARGET), state.target);
    add(ids.feature(TF.MODE), gladysModeOf(state));
    add(ids.feature(TF.MAX_MODE), MODE_NAMES[state.mode]);
    if (item.kind === KINDS.THERMOSTAT) {
      add(ids.feature(TF.VALVE), state.valve);
      add(
        ids.feature(TF.OPERATING),
        isNumber(state.valve)
          ? state.valve > 0
            ? OPERATING_STATE.HEATING
            : OPERATING_STATE.IDLE
          : undefined,
      );
    }
  }
  return states;
}
