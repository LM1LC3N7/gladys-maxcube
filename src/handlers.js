// -----------------------------------------------------------------------------
// The SDK handlers, wired to the app. Shared by index.js and the tests, so
// the tests run the exact wiring of the container.
// -----------------------------------------------------------------------------

import { ACTIONS } from './constants.js';
import { T } from './i18n.js';

/** A configuration not read is asked again after 30 s, then doubled up to 10 min. */
export const CONFIG_RETRY_MIN_MS = 30_000;
export const CONFIG_RETRY_MAX_MS = 10 * 60_000;

export function registerHandlers(gladys, app, logger) {
  // --- Discovery and device lifecycle ------------------------------------------
  gladys.onScanRequest(() => app.publishDiscovery());
  gladys.onDeviceCreated((device) => app.deviceCreated(device));
  gladys.onDeviceDeleted((device) => app.deviceDeleted(device));
  // Updated: the SDK forgot its states, and Gladys may have reset its badge.
  gladys.onDeviceUpdated((device) => app.deviceUpdated(device));

  // --- Commands: setpoint and mode (both refused unless allowed) ----------------
  gladys.onSetValue((device, feature, value) => app.setValue(device, feature, value));

  // --- Configuration screen button ----------------------------------------------
  gladys.onAction(ACTIONS.TEST, () => app.testConnection());

  // --- Configuration saved by the user -------------------------------------------
  gladys.onConfigUpdated((config) => {
    logger?.info('Configuration updated: restarting');
    return app.start(config);
  });

  // --- Connection lifecycle: every connection publishes everything again; the
  // same configuration keeps the connection to the Cube and the loop.
  // A configuration that cannot be read is asked again, without end, 30 s,
  // 1 min, 2 min... up to every 10 min, the status saying so. One chain at a
  // time: a new connection or a disconnection cancels the one waiting.
  let chain = 0;
  let handle;
  const cancel = () => {
    chain += 1;
    if (handle !== undefined) app.timers.clearTimeout(handle);
    handle = undefined;
  };
  const startWithConfig = async (token, attempt = 0) => {
    let config;
    try {
      config = await gladys.getConfig();
    } catch (err) {
      if (token !== chain) return;
      const delay = Math.min(CONFIG_RETRY_MIN_MS * 2 ** attempt, CONFIG_RETRY_MAX_MS);
      logger?.warn(`Configuration not read, asked again: ${err?.message ?? 'error'}`);
      await app.setStatus(false, T.status.configNotRead(delay));
      if (token !== chain) return;
      handle = app.timers.setTimeout(() => {
        handle = undefined;
        void startWithConfig(token, attempt + 1);
      }, delay);
      return;
    }
    if (token !== chain) return;
    try {
      await app.start(config);
    } catch (err) {
      logger?.error(`Start failed (${err?.name ?? 'Error'})`);
    }
  };
  gladys.on('connected', () => {
    cancel();
    return startWithConfig(chain);
  });
  gladys.on('disconnected', () => {
    cancel();
    app.pause();
  });
}
