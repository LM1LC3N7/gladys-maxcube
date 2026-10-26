// -----------------------------------------------------------------------------
// The SDK handlers, wired to the app. Shared by index.js and the tests, so
// the tests run the exact wiring of the container.
// -----------------------------------------------------------------------------

import { ACTIONS } from './constants.js';

/** How many more times the configuration is asked for after a failed read. */
export const CONFIG_RETRIES = 3;

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
  // The configuration that cannot be read is asked again, a bounded number of
  // times (30 s, 60 s, 120 s), on the app's timers.
  const startWithConfig = async (attempt = 0) => {
    let config;
    try {
      config = await gladys.getConfig();
    } catch (err) {
      if (attempt >= CONFIG_RETRIES) {
        logger?.error(`Configuration not read: ${err?.message ?? 'error'}`);
        return;
      }
      logger?.warn(`Configuration not read, asked again: ${err?.message ?? 'error'}`);
      app.timers.setTimeout(() => startWithConfig(attempt + 1), 30_000 * 2 ** attempt);
      return;
    }
    try {
      await app.start(config);
    } catch (err) {
      logger?.error(`Start failed (${err?.name ?? 'Error'})`);
    }
  };
  gladys.on('connected', () => startWithConfig());
  gladys.on('disconnected', () => app.pause());
}
