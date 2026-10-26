# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** for the eQ-3 MAX! Cube through
its local TCP port 62910: a Node.js service (Node 22+, ESM, no build step)
that runs in its own sandboxed Docker container and talks to Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template;
the protocol is ported from Bouni/max-cube-protocol and python-maxcube-api
(both MIT, see THIRD_PARTY_NOTICES.md).

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
node --test --test-name-pattern "mode"    # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npm run cover                             # regenerate cover.png
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js               SDK wiring only (src/handlers.js registers every handler before connect())
src/handlers.js        the SDK handlers, shared with the tests
src/app.js             MaxCubeApp: lifecycle, reading loop, states, commands, button
src/cube/client.js     the one TCP connection: bounded lines, greeting, l: / s: exchanges, pushes
src/cube/protocol.js   H, M, C, L, S messages and the s command 40 (pure)
src/devices.js         Gladys devices and states (pure), never losing a created feature
src/store.js           /data: the time of the last read
src/budget.js          states per minute
src/config.js          DEFAULTS (mirror the manifest defaults) + normalization
src/i18n.js            texts (status and button en/fr, errors en, device names fr/en)
src/constants.js       keys, limits, timings
test/                  node --test, against the SDK's fake Gladys, a fake Cube and a real local TCP server
test/fixtures/cube.js  the messages of the protocol documentation and our encoders
```

## Rules

- **External ids are forever**: `<kind>:<serial number>`. The same goes for
  every key users store: manifest `config_schema`, `actions`, feature keys.
- **The container rootfs is read-only.** Write only under `/data`. Never log
  what the Cube sends (serials, names, values): only our own words, device
  kinds and numbers.
- **Only `l:`, `s:` (command 40) and `q:` are ever written to the Cube.**
  Never the reset (`a:`), the pairing (`n:`, `x:`), the deletion (`t:`), the
  metadata write (`m:`), the time and NTP commands.
- **One connection** to the Cube at a time (it accepts one client): never a
  second `openConnection` while one is in progress or open.
- **Off is protective** (manual 4.5 °C): never behind an option, bounds,
  values, a read in flight or a command not yet written; it waits only for
  the answer to a command already written. Never make it depend on more.
- **Setpoint, auto and heating** stay behind `allow_setpoint` / `allow_mode`
  (off by default), checked at arrival and just before sending, decided on
  valid live values asked just before. The setpoint is 5-30 °C by half
  degrees within the bounds of every thermostat of the room, never clamped;
  cooling never.
- **Budgets on the monotonic clock** (commands, state budget, duty cycle
  freshness); the wall clock dates `/data` only.
- **The loop never reads sooner than the interval**: the test button,
  Discovery, a reconnection to Gladys and a restart (`/data`); the follow-up
  reads of a command apart. One read of the monotonic clock per decision,
  the instant handed on (`dueAt(mono)`).
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md`. Never write a version heading.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`.
  No secret field: the Cube asks for no password.
- **User-facing text** is bilingual (English and French): status, button
  answers, manifest texts, and `docs/en.md` / `docs/fr.md`, kept in sync.
  Files are UTF-8 without BOM (`test/encoding.test.js`).
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network (loopback only).
