// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { DEVICE_FEATURE_UNITS } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { DEFAULTS, LANGUAGES } from '../src/config.js';
import { ACTIONS, SETPOINT } from '../src/constants.js';
import { buildDevices } from '../src/devices.js';
import { TRV, WALL, WINDOW } from './fixtures/cube.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const handlers = read('src/handlers.js');
const dockerfile = read('Dockerfile');

// The core's own validator of supported_options, when a Gladys clone is at hand
// (not on GitHub CI).
const CORE_NORMALIZE = '/home/claude/code/Gladys/server/utils/normalizeSupportedOptions.js';
const normalizeSupportedOptions = existsSync(CORE_NORMALIZE)
  ? createRequire(import.meta.url)(CORE_NORMALIZE).normalizeSupportedOptions
  : undefined;

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) yield* texts(item, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) yield* texts(value, `${path}.${key}`);
  }
}

const keys = (list) => (list ?? []).map((item) => item.key);
const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));

const model = () => ({
  cube: { serial: 'KEQ0523864', firmware: '1.1.3', dutyCycle: 0, freeSlots: 50 },
  rooms: 2,
  devices: [
    {
      kind: 'thermostat',
      type: 2,
      serial: TRV.serial,
      rfAddress: TRV.rf,
      name: 'R',
      roomId: 1,
      roomName: 'L',
      config: { comfort: 21, eco: 17, max: 30.5, min: 4.5 },
    },
    {
      kind: 'wall',
      type: 3,
      serial: WALL.serial,
      rfAddress: WALL.rf,
      name: 'W',
      roomId: 1,
      roomName: 'L',
    },
    {
      kind: 'window',
      type: 4,
      serial: WINDOW.serial,
      rfAddress: WINDOW.rf,
      name: 'X',
      roomId: 2,
      roomName: 'B',
    },
  ],
});

test('the store basics; version 0.1.0 set by hand everywhere, never fixed in the tests', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.equal(manifest.gladys_version, '>=5.1.0');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-maxcube:${manifest.version}`);
  assert.equal(pkg.name, 'gladys-maxcube');
  assert.equal(lock.name, 'gladys-maxcube');
  assert.deepEqual(Object.keys(pkg.dependencies), ['@gladysassistant/integration-sdk']);
  assert.deepEqual(manifest.transports, ['local']);
  assert.deepEqual(manifest.categories, ['climate']);
  assert.equal(manifest.keywords, undefined, 'keywords would need Gladys 5.3.0');
  assert.equal(manifest.countries, undefined);
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    assert.ok(read(`docs/${lang}.md`).length >= 300, `docs/${lang}.md is too short for the store`);
  }
  assert.match(fields.intro.description.en, /Unofficial integration, not affiliated with eQ-3/);
  assert.match(fields.intro.description.fr, /non officielle, sans lien avec eQ-3/);
  assert.match(fields.intro.description.en, /Never tested with a real Cube/);
  assert.match(fields.intro.description.fr, /Jamais testée avec un vrai Cube/);
  assert.match(read('docs/en.md'), /never been tested with a real Cube/);
  assert.match(read('docs/fr.md'), /jamais été testée avec un vrai Cube/);
  assert.match(read('README.md'), /Never tested with a\s+real Cube/);
});

test('the license and the notices ship in the image; no person named in LICENSE', () => {
  const license = read('LICENSE');
  assert.match(license, /Apache License\s+Version 2\.0/);
  assert.match(license, /Copyright \[yyyy\] \[name of copyright owner\]/, 'the standard text');
  const notices = read('THIRD_PARTY_NOTICES.md');
  assert.match(notices, /python-maxcube-api[\s\S]*MIT License/);
  assert.match(notices, /max-cube-protocol[\s\S]*MIT License/);
  assert.match(dockerfile, /COPY[^\n]*LICENSE[^\n]*THIRD_PARTY_NOTICES\.md/);
  assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts/);
});

test('every text is bilingual', () => {
  for (const [path, text] of texts(manifest)) {
    assert.ok(text.en?.trim() && text.fr?.trim(), `${path} needs en and fr`);
  }
});

test('the configuration matches the code; every command off by default; no secret, no gladys_ key', () => {
  for (const [key, value] of Object.entries(DEFAULTS)) {
    assert.equal(fields[key].default, value, key);
  }
  assert.deepEqual(
    fields.language.options.map((o) => o.value),
    LANGUAGES,
  );
  assert.deepEqual(keys(manifest.config_schema), [
    'intro',
    'host',
    'options_section',
    'allow_setpoint',
    'allow_mode',
    'keep_connection',
    'language',
  ]);
  assert.ok(manifest.config_schema.every((f) => !f.key.startsWith('gladys_')));
  assert.ok(manifest.config_schema.every((f) => f.type !== 'secret'));
  assert.doesNotMatch(
    JSON.stringify(manifest) + read('docs/fr.md') + read('docs/en.md') + read('README.md'),
    /chiffré|encrypted/i,
  );
  for (const key of ['allow_setpoint', 'allow_mode']) {
    assert.equal(fields[key].type, 'boolean', key);
    assert.equal(fields[key].default, false, key);
  }
  assert.match(
    fields.allow_setpoint.description.en,
    new RegExp(`${SETPOINT.MIN} to ${SETPOINT.MAX} °C`),
  );
  assert.match(fields.allow_mode.description.en, /off \(the valve closed/);
  assert.match(fields.options_section.description.en, /one client at a time|whole room/);
});

test('sections store nothing', () => {
  for (const section of manifest.config_schema.filter((f) => f.type === 'section')) {
    assert.equal(section.required, undefined, section.key);
    assert.equal(section.default, undefined, section.key);
    assert.ok(!(section.key in DEFAULTS), section.key);
    for (const link of section.links ?? []) assert.match(link.url, /^https:\/\//);
  }
});

test('the keys of the manifest are the keys of the code, all registered', () => {
  assert.deepEqual(keys(manifest.actions).sort(), Object.values(ACTIONS).sort());
  for (const name of Object.keys(ACTIONS)) {
    assert.ok(handlers.includes(`onAction(ACTIONS.${name}`), name);
  }
  assert.ok(manifest.actions.every((a) => a.timeout_seconds >= 5 && a.timeout_seconds <= 120));
  assert.equal(manifest.scene_actions, undefined);
  assert.equal(manifest.scene_triggers, undefined);
  assert.equal(manifest.widgets, undefined);
  for (const handler of ['onScanRequest(', 'onSetValue(', 'onConfigUpdated(', 'onDeviceCreated(']) {
    assert.ok(handlers.includes(handler), handler);
  }
});

test('units: only those the core lists for the category (server/utils/constants.js)', () => {
  // DEVICE_FEATURE_UNITS_BY_CATEGORY of the core, for the categories used here.
  const allowed = {
    'temperature-sensor': ['celsius', 'fahrenheit', 'kelvin'],
    thermostat: ['celsius', 'fahrenheit'],
    // unknown, battery-low, opening-sensor and text: no unit.
  };
  const gladys = createFakeGladys({ selector: 'maxcube' });
  const features = buildDevices(gladys, model(), 'en', []).flatMap((d) => d.features);
  assert.ok(features.length > 15);
  for (const feature of features) {
    if (feature.unit === undefined) continue;
    assert.ok(Object.values(DEVICE_FEATURE_UNITS).includes(feature.unit), feature.unit);
    assert.ok(
      allowed[feature.category]?.includes(feature.unit),
      `${feature.name}: ${feature.unit}`,
    );
  }
  // Enums carry no unit (UNITS_BY_CATEGORY_AND_TYPE): mode, operating state.
  for (const feature of features.filter((f) => f.category === 'thermostat')) {
    if (feature.type !== 'target-temperature') assert.equal(feature.unit, undefined, feature.name);
  }
  assert.ok(features.every((f) => typeof f.name === 'string' && f.name.length > 0));
  // The only commands: the setpoint and the mode; never a switch.
  const writable = features.filter((f) => !f.read_only);
  assert.deepEqual(writable.map((f) => `${f.category}/${f.type}`).sort(), [
    'thermostat/mode',
    'thermostat/mode',
    'thermostat/target-temperature',
    'thermostat/target-temperature',
  ]);
  assert.ok(features.every((f) => f.category !== 'switch'));
  // No supported_options in v1; the core's validator would want string labels.
  for (const feature of features) {
    if (!feature.supported_options) continue;
    assert.ok(feature.supported_options.every((o) => typeof o.label === 'string'));
    if (normalizeSupportedOptions) {
      assert.doesNotThrow(() => normalizeSupportedOptions(feature.supported_options));
    }
  }
});
