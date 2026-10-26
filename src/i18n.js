// -----------------------------------------------------------------------------
// Runtime texts shown in Gladys. The connection status and the button answers
// are { en, fr }; errors thrown to Gladys (a refused command) are English, one
// language per message like the core's; the device texts (feature names)
// follow the language chosen in the configuration. They never quote a text
// of the Cube: only our own words and error kinds.
// -----------------------------------------------------------------------------

import { ERROR_KINDS } from './cube/client.js';

const seconds = (ms) => Math.max(1, Math.round(ms / 1000));
const minutes = (ms) => Math.max(1, Math.round(ms / 60_000));
const delay = (ms) => (ms >= 59_500 ? `${minutes(ms)} min` : `${seconds(ms)} s`);
const plural = (n, one, many) => (n === 1 ? one : many);

/** Why the Cube failed, in a few words (error kinds only). */
export function reasonOf(err) {
  switch (err?.kind) {
    case ERROR_KINDS.UNREACHABLE:
      return { en: 'no connection', fr: 'pas de connexion' };
    case ERROR_KINDS.TIMEOUT:
      return { en: 'no answer in time', fr: 'pas de réponse à temps' };
    case ERROR_KINDS.CLOSED:
      return { en: 'connection closed', fr: 'connexion fermée' };
    case ERROR_KINDS.PROTOCOL:
      return { en: 'unexpected answer', fr: 'réponse inattendue' };
    case ERROR_KINDS.REJECTED:
      return { en: 'discarded by the Cube', fr: 'rejetée par le Cube' };
    case ERROR_KINDS.LATE:
      return { en: 'too late', fr: 'trop tard' };
    default:
      return { en: 'error', fr: 'erreur' };
  }
}

const join = (...parts) => ({
  en: parts
    .map((p) => p?.en)
    .filter(Boolean)
    .join(' '),
  fr: parts
    .map((p) => p?.fr)
    .filter(Boolean)
    .join(' '),
});

const RETRY = (ms) => ({ en: `New try in ${delay(ms)}.`, fr: `Nouvel essai dans ${delay(ms)}.` });

export const T = {
  status: {
    ok: ({ serial, firmware, devices, rooms, created, notes = [] }) =>
      join(
        {
          en: `Connected to the MAX! Cube ${serial} (firmware ${firmware ?? '?'}): ${devices} ${plural(devices, 'device', 'devices')} in ${rooms} ${plural(rooms, 'room', 'rooms')}.`,
          fr: `Connecté au MAX! Cube ${serial} (firmware ${firmware ?? '?'}) : ${devices} ${plural(devices, 'appareil', 'appareils')} dans ${rooms} ${plural(rooms, 'pièce', 'pièces')}.`,
        },
        created === 0 && devices > 0
          ? {
              en: 'Create them from the "Discover" tab to receive their values.',
              fr: 'Créez-les depuis l’onglet « Découverte » pour recevoir leurs valeurs.',
            }
          : undefined,
        ...notes,
      ),
    hostEmpty: {
      en: 'Type the address of the MAX! Cube (its IP address on your network, e.g. 192.168.1.40).',
      fr: 'Saisissez l’adresse du MAX! Cube (son adresse IP sur votre réseau, ex. 192.168.1.40).',
    },
    hostInvalid: {
      en: 'The address of the Cube is not valid: type its IP address or host name (e.g. 192.168.1.40), without http:// nor a path; a port may follow (62910 by default).',
      fr: 'L’adresse du Cube n’est pas valide : saisissez son adresse IP ou son nom (ex. 192.168.1.40), sans http:// ni chemin ; un port peut suivre (62910 par défaut).',
    },
    hostCredentials: {
      en: 'Remove the user name and password from the address: the Cube asks for none.',
      fr: 'Retirez l’identifiant et le mot de passe de l’adresse : le Cube n’en demande pas.',
    },
    waiting: (ms) => ({
      en: `The Cube was read less than a minute ago (before a restart): next read in ${delay(ms)}.`,
      fr: `Le Cube a été lu il y a moins d’une minute (avant un redémarrage) : prochaine lecture dans ${delay(ms)}.`,
    }),
    unreachable: (err, ms) =>
      join(
        {
          en: `The Cube could not be read (${reasonOf(err).en}). Only one client at a time can be connected to a Cube: close the MAX! software or any other integration using it.`,
          fr: `Le Cube n’a pas pu être lu (${reasonOf(err).fr}). Un seul client à la fois peut être connecté à un Cube : fermez le logiciel MAX! ou toute autre intégration qui l’utilise.`,
        },
        RETRY(ms),
      ),
    notCube: (ms) =>
      join(
        {
          en: 'This address does not answer like a MAX! Cube: check the address and the port (62910).',
          fr: 'Cette adresse ne répond pas comme un MAX! Cube : vérifiez l’adresse et le port (62910).',
        },
        RETRY(ms),
      ),
  },
  notes: {
    dutyCycle: (percent) => ({
      en: `The radio budget of the Cube is at ${percent} % of its hourly allowance: commands may be delayed or discarded until the next hour.`,
      fr: `Le budget radio du Cube est à ${percent} % de son quota horaire : les commandes peuvent être retardées ou rejetées jusqu’à l’heure suivante.`,
    }),
    missing: (n) => ({
      en: `${n} ${plural(n, 'device gives', 'devices give')} no values yet (not heard by the Cube).`,
      fr: `${n} ${plural(n, 'appareil ne donne', 'appareils ne donnent')} pas encore de valeurs (pas entendus par le Cube).`,
    }),
    batteryLow: (n) => ({
      en: `${n} ${plural(n, 'device reports', 'devices report')} a low battery.`,
      fr: `${n} ${plural(n, 'appareil signale', 'appareils signalent')} une pile faible.`,
    }),
    linkError: (n) => ({
      en: `${n} ${plural(n, 'device reports', 'devices report')} a radio link error.`,
      fr: `${n} ${plural(n, 'appareil signale', 'appareils signalent')} une erreur de liaison radio.`,
    }),
  },
  test: {
    ok: ({ serial, firmware, thermostats, walls, windows, missing }) => {
      const parts = [];
      if (thermostats)
        parts.push({
          en: `${thermostats} radiator ${plural(thermostats, 'thermostat', 'thermostats')}`,
          fr: `${thermostats} ${plural(thermostats, 'thermostat', 'thermostats')} de radiateur`,
        });
      if (walls)
        parts.push({
          en: `${walls} wall ${plural(walls, 'thermostat', 'thermostats')}`,
          fr: `${walls} ${plural(walls, 'thermostat mural', 'thermostats muraux')}`,
        });
      if (windows)
        parts.push({
          en: `${windows} window ${plural(windows, 'contact', 'contacts')}`,
          fr: `${windows} ${plural(windows, 'contact de fenêtre', 'contacts de fenêtre')}`,
        });
      const list = (lang) => (parts.length ? parts.map((p) => p[lang]).join(', ') : '-');
      return join(
        {
          en: `MAX! Cube ${serial} read (firmware ${firmware ?? '?'}): ${list('en')}.`,
          fr: `MAX! Cube ${serial} lu (firmware ${firmware ?? '?'}) : ${list('fr')}.`,
        },
        missing ? T.notes.missing(missing) : undefined,
      );
    },
    slow: {
      en: 'The Cube is slow to answer: look at the integration status in a minute.',
      fr: 'Le Cube tarde à répondre : regardez l’état de l’intégration dans une minute.',
    },
    notDue: (ms) => ({
      en: `The Cube was read less than a minute ago: it is not read again sooner than every minute. Next read in ${delay(ms)}; the status shows the last read.`,
      fr: `Le Cube a été lu il y a moins d’une minute : il n’est jamais relu plus vite qu’une fois par minute. Prochaine lecture dans ${delay(ms)} ; l’état montre la dernière lecture.`,
    }),
  },
  // Errors thrown to Gladys for a refused command: English, our own words only.
  errors: {
    unknownDevice: 'Unknown MAX! feature',
    setpointDisabled:
      'The setpoint commands are off: tick "Allow the setpoint commands" in the configuration of the integration',
    modeDisabled:
      'The mode commands are off: tick "Allow the mode commands" in the configuration of the integration',
    notConfigured: 'The address of the Cube is not set',
    configChanged: 'The configuration changed meanwhile: command not sent',
    tooSlow: 'The Cube is too slow to answer: command not sent',
    unknownState: (err) =>
      `The Cube could not be read just before acting (${reasonOf(err).en}): command not sent`,
    gone: 'This device is no longer paired with the Cube: command not sent',
    notHeard:
      'The Cube has no values yet for this device (not heard over the radio): command not sent',
    invalidSetpoint: (min, max) =>
      `The setpoint must be a number from ${min} to ${max} °C (half degrees)`,
    badBounds:
      'The Cube gives setpoint bounds for this device that leave no valid value: command not sent',
    invalidMode: 'The mode must be 0 (off), 1 (heating) or 3 (auto, the weekly programme)',
    coolingMode: 'A MAX! thermostat does not cool: mode not sent',
    noComfort:
      'The Cube gives no comfort temperature for this device: switch to heating with a setpoint instead',
    notSent: (err) => `Command not sent to the Cube (${reasonOf(err).en})`,
    rejected:
      'The Cube discarded the command: its radio budget for the hour is used up, or it has no free slot. Try again later',
    unconfirmed: (err) =>
      `Command sent to the Cube, without confirmation (${reasonOf(err).en}): the next read will show whether it was accepted`,
    testTooLong: 'The Cube did not answer within 25 s',
  },
};

/** The names of the devices and features, in the language of the configuration. */
const DEVICE_TEXTS = {
  en: {
    cube: (serial) => `MAX! Cube ${serial}`,
    thermostat: (name) => `${name} (MAX! radiator thermostat)`,
    wall: (name) => `${name} (MAX! wall thermostat)`,
    window: (name) => `${name} (MAX! window contact)`,
    features: {
      duty_cycle: 'Radio duty cycle (%)',
      free_slots: 'Free command slots',
      temperature: 'Temperature',
      target: 'Setpoint',
      mode: 'Mode',
      max_mode: 'MAX! mode (auto, manual, vacation, boost)',
      operating: 'Heating state',
      valve: 'Valve opening (%)',
      battery_low: 'Battery low',
      link_error: 'Radio link error',
      contact: 'Window',
    },
  },
  fr: {
    cube: (serial) => `MAX! Cube ${serial}`,
    thermostat: (name) => `${name} (thermostat de radiateur MAX!)`,
    wall: (name) => `${name} (thermostat mural MAX!)`,
    window: (name) => `${name} (contact de fenêtre MAX!)`,
    features: {
      duty_cycle: 'Budget radio utilisé (%)',
      free_slots: 'Emplacements de commande libres',
      temperature: 'Température',
      target: 'Consigne',
      mode: 'Mode',
      max_mode: 'Mode MAX! (auto, manual, vacation, boost)',
      operating: 'État du chauffage',
      valve: 'Ouverture de la vanne (%)',
      battery_low: 'Pile faible',
      link_error: 'Erreur de liaison radio',
      contact: 'Fenêtre',
    },
  },
};

export const texts = (language) => DEVICE_TEXTS[language] ?? DEVICE_TEXTS.fr;
