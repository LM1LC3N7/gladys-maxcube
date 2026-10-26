// -----------------------------------------------------------------------------
// The configuration the user fills (manifest `config_schema`), normalized.
// No secret: the Cube asks for no password on its local port.
// -----------------------------------------------------------------------------

import { DEFAULT_PORT } from './constants.js';

export const LANGUAGES = Object.freeze(['fr', 'en']);

// Defaults: they MUST match the `default` values of the manifest.
export const DEFAULTS = Object.freeze({
  language: 'fr',
  allow_setpoint: false,
  allow_mode: false,
  keep_connection: true,
});

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const bool = (value, fallback) => {
  if (value === true || value === 'true' || value === 1 || value === '1') return true;
  if (value === false || value === 'false' || value === 0 || value === '0') return false;
  return fallback;
};

/**
 * The address of the Cube: `192.168.1.20`, `maxcube.local` or `host:port`
 * (62910 by default, the only port of the Cube). A scheme, credentials, a
 * path, a query and a fragment are refused (an address ends up in logs).
 *   -> { host, port } or { error: 'empty' | 'invalid' | 'credentials' }
 */
export function parseHost(value) {
  const raw = text(value);
  if (!raw) return { error: 'empty' };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return { error: 'invalid' };
  if (raw.includes('@')) return { error: 'credentials' };
  if (/[\s/?#\\]/.test(raw)) return { error: 'invalid' };
  let url;
  try {
    url = new URL(`http://${raw}`);
  } catch {
    return { error: 'invalid' };
  }
  if (!url.hostname || url.pathname !== '/' || url.search || url.hash) return { error: 'invalid' };
  const port = url.port ? Number(url.port) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: 'invalid' };
  // An IPv6 address comes back in brackets: node:net wants it bare.
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  return { host, port };
}

export function normalizeConfig(raw = {}) {
  raw = raw ?? {};
  const host = parseHost(raw.host);
  const language = LANGUAGES.includes(String(raw.language))
    ? String(raw.language)
    : DEFAULTS.language;
  return {
    cube: host.error ? null : host,
    hostError: host.error ?? null,
    language,
    allowSetpoint: bool(raw.allow_setpoint, DEFAULTS.allow_setpoint),
    allowMode: bool(raw.allow_mode, DEFAULTS.allow_mode),
    keepConnection: bool(raw.keep_connection, DEFAULTS.keep_connection),
  };
}
