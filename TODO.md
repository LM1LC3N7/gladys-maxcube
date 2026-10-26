# TODO — MAX! Cube (eQ-3) v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `gi ci` (Prettier, ESLint, tests on Node 24 and 22,
  Docker build, store validator), `npm audit --omit=dev`, then update README,
  `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- The `gladys-assistant-integration` topic is added at the first real release
  only. No forum topic of its own: the claim is in /t/10385 (lot 16).

## Status

- [x] **Milestone 1 — core** (2026-10-25): the local TCP protocol of the Cube
      ported from Bouni/max-cube-protocol and python-maxcube-api (greeting
      H / M / C / L, `l:`, `s:` command 40, `q:`); radiator and wall
      thermostats, window contacts, the Cube itself; commands off by default
      (setpoint, mode) with the live values asked to the Cube before acting;
      one connection, kept or per read; the time of the last read in `/data`;
      button "Test the connection"; docs en/fr. Unit tests against the SDK's
      fake Gladys and a fake Cube, a real local TCP server for the
      connection, a real-clock test of the loop. **Never tested with a real
      Cube.**
- [x] **Review r1 fixes** (2026-10-26): off protective (no option, identity
      only, ahead of reads and unwritten commands, checked and sent again);
      commands confirmed on the follow-up reads; valid values only; radio
      budget; monotonic budgets; per-device isolation of C and L; the
      configuration read again without end; docs with exact refusal lists.
- [ ] **Milestone 2 — real Cube** (a tester with a Cube and a few
      thermostats): record a real greeting as a fixture (serials replaced),
      fix what differs. To check first:
  - the room temperature of a radiator thermostat: bytes 9-10 of the L entry
    read as 9 bits (the low bit of byte 9, then byte 10), only in auto and
    manual modes, 0 = not measured, and only when the 7 other bits of byte 9
    are 0 (else a date); python-maxcube-api reads byte 9 whole;
  - the `valid` / `initialized` flags of the L entries: values held back
    when either is off (python-maxcube-api ignores them): check that a real
    Cube sets both on its working devices;
  - whether a pushed `L:` lists every device or only the one that reported
    (handled as partial: only the devices it lists change);
  - whether the Cube pushes `L:` on its own on a kept connection (it does in
    python-maxcube-api's "unsolicited messages"), and how soon the L reflects
    a command (the thermostat applies it when it listens, up to a few
    minutes);
  - whether a second client is refused or replaces the first (the status
    message assumes the Cube keeps one client);
  - the `M:` cut in several blocks: the base64 text joined, or each block
    decoded on its own when padded (`decodeMetadata`);
  - the rf flag 04 (room) with the device address: the whole room follows,
    as python-maxcube-api and the MAX! software do;
  - whether an `s:` with mode auto and temperature 0 really brings a
    thermostat back to its programme (python-maxcube-api issue 24 says yes
    since 0.4.0).
- [ ] **v2 ideas**: boost and vacation (needs the until date in the s command),
      comfort / eco presets as `thermostat` / `preset`, the push buttons
      (Eco Switch) as events, the "window open" temperature, the UDP
      discovery of the Cube (`eQ3Max*\0**********I`), `poll_frequency`
      once the core polls, the `keywords` (`max`, `eq-3`, `cube`,
      `thermostat`, `heating`) and `countries` (DE, AT, CH, NL, BE, FR, GB,
      IT, ES) of the manifest with `gladys_version >= 5.3.0` at the SDK 0.16
      migration.

## Decisions

- **Version**: 0.1.0 set by hand in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag; the first Release (patch) gives 0.1.1.
- **SDK**: `^0.15.0`. The template asked for `^0.16.0`, not on npm on
  2026-10-25 (0.15.0 is the latest published): migration to 0.16 planned with
  the first migration wave, with `keywords`, `countries` and
  `gladys_version >= 5.3.0` (see `_lots/veille.md`).
- **License**: Apache-2.0, the standard text (no person named), shipped in the
  image with `THIRD_PARTY_NOTICES.md` (full MIT notices of python-maxcube-api
  and Bouni/max-cube-protocol, both checked: MIT, not GPL).
- **Ported from the documentation**, python-maxcube-api being frozen since
  2021: the protocol (`src/cube/protocol.js`) follows Bouni/max-cube-protocol
  for the byte layouts and python-maxcube-api for what it reads and sends
  (command 40 only). Only `l:`, `s:` and `q:` are ever written: never `a:`
  (reset: python-maxcube-api issue 12), `n:` / `x:` (pairing), `t:`
  (delete), `m:` (metadata write), `f:` / `v:` (NTP, time).
- **One connection** (a Cube accepts one client): kept by default, as
  python-maxcube-api 0.4.0 (`use_persistent_connection`), with the
  `keep_connection` option to release it between reads so the MAX! software
  can connect (0.4.1 rollback); renewed every 6 h for fresh names. A second
  opening never starts while one is in progress; the old connection is
  closed with `q:` before a new one.
- **Interval**: 1 min (`l:` is the cache of the Cube, no radio; Home
  Assistant reads every 5 min but relies on pushes too). The loop never
  reads sooner: the test button, Discovery, a reconnection to Gladys, a
  restart (`lastAttemptAt` in `/data`, written before the read). Apart: a
  command reads just before acting, and its follow-up reads (5 s, 30 s,
  1 min, 2 min after its write). The test button waits for the interval but
  not for the retry pause (1 to 10 min).
- **External ids**: the serial numbers of the devices (`SERIAL`,
  10 letters / digits) and of the Cube: stable across addresses, rooms and
  names. A device without a usable serial, or a duplicate, is dropped (logged
  as a count). RF addresses are only used to match the L entries and to
  address commands, from the metadata of the current connection.
- **Devices**: `thermostat` (types 1 and 2), `wall` (3), `window` (4), `cube`
  (duty cycle, free slots); push buttons (5) ignored. Names `Room - Name`.
  Temperatures: `temperature-sensor` / `decimal`; setpoint `thermostat` /
  `target-temperature` (min 4.5 so the off setpoint shows, max the device's
  within 30); mode `thermostat` / `mode` (off 0, heating 1, auto 3; cooling
  never); MAX! mode `text` / `text`; heating state `thermostat` /
  `operating-state` from the valve; valve `unknown` / `decimal` (no unit:
  the core lists none for `unknown`); battery `battery-low` / `binary`; link
  error `unknown` / `binary`; window `opening-sensor` / `binary` (1 closed,
  0 open, as the core's OPENING_SENSOR_STATE).
- **Values**: shown only from an entry valid and initialized without a
  radio link error (else only the battery and link flags, an unreachable
  badge and a note); a target only within 4.5-30.5 (0 = never heard); a
  radiator temperature only in auto / manual, when the 7 high bits of its
  first byte are 0 and 0 < t < 60 °C. A pushed L changes only the devices it
  lists; the answer to `l:` replaces all. Two devices on one RF address are
  both left out (counted in the log). A C that does not decode or names
  another address is skipped (that device has no configuration); an L entry
  shorter than 6 bytes is skipped; only framing errors (line too long, bad
  base64, an entry past the end, a greeting without H or a complete M, a
  Cube serial not of 10 letters / digits) cut the connection.
- **Off (protective)**: manual 4.5 °C (the MAX! off) to the room. Decision of
  the r1 review: closing the valve is the safe side for a heating, so off
  needs no option (`allow_mode` covers auto and heating only), no bounds and
  no values, only the device in the metadata of the connection (which
  cannot change while we hold the one client slot; a new connection reads
  it again). Always sent (idempotent, never "already off"). At its arrival:
  the queued commands of its room are cancelled, the running one too if not
  written yet; a read in flight (loop or command) or an exchange stalled for
  2.5 s cuts the connection (the cut read is not a failure: read again 5 s
  later) and the stop opens a new one; it goes ahead of every exchange still
  waiting (priority queue of the connection) and only waits for the answer
  to an exchange already written (2 s at most). An opening in progress is
  waited for (the Cube accepts one client), within the 3.5 s budget.
  Checked on the follow-up reads: not applied 1 min after a write, sent
  again, 3 times at most (not with a fresh duty cycle of 90 % or more);
  still not applied 2 min after the last write: warn log and a status note
  naming the device, until it shows it or another command replaces it.
- **Setpoint, auto, heating**: `allow_setpoint` and `allow_mode`, off by
  default, checked when the command arrives AND just before the write; a
  permission taken away applies at once (`restrict`). Decided on the L
  asked just before (or the greeting of a new connection), valid values
  only, never on memory. Refused besides: a setpoint on a thermostat that is
  off without `allow_mode` (it would start it); bounds of the room that
  leave nothing; a fresh duty cycle of 90 % or more, or no free slot.
  "Already" only when every thermostat of the room shows it. Not applied
  2 min after the write: a warn log, not sent again.
- **Budgets on the monotonic clock**: arrival, deadline (3.5 s), `beforeSend`
  and the answer to Gladys (4.3 s); answers: "accepted" (S result 0 with
  budget left), "queued" (S result 0 at 100 % or no free slot), "discarded"
  (S result 1), "sent, without confirmation" (no S yet, a timeout, a close
  after the write), "not sent" (never written).
- **Radio budget**: the duty cycle and free slots of H and of every S, with
  their instant; fresh 10 min (the Cube resets it hourly): not published,
  not noted and not used to refuse once older.
- **Setpoint**: 5-30 °C (the MAX! range; 4.5 = off, 30.5 = on, never
  commanded as setpoints) narrowed to the C min / max of every thermostat of
  the room, rounded to 0.5 (the resolution); the raw value and the rounded
  one both checked, never clamped; rf flag 04 with the room id (the whole
  room follows, as the MAX! software), 00 without a room. In auto: auto with
  the temperature (until the next switch point); otherwise manual.
- **Heating / auto**: AUTO = temperature 0 mode auto; HEATING = manual at the
  current target, else the comfort temperature of the C message (refused if
  unknown or out of bounds). Boost and vacation are not commands (vacation
  needs an until date; boost ends by itself).
- **keep_connection off**: the connection is counted in uses (loop reads,
  commands, writes in flight) and closed with `q:` at 0 uses only.
- **Configuration**: asked again without end when Gladys cannot give it
  (30 s doubled up to 10 min, the status says so), one chain at a time,
  cancelled at a disconnection or a new connection; a command before it is
  loaded: "not loaded yet".
- **Bounds**: a line 16 KiB, a greeting 200 lines / 256 KiB, 20 M blocks,
  100 devices and rooms, 200 L entries, names 40 characters without control
  characters; every index checked (`Reader.need`); linear parsing, chunks
  joined once per line.
- **Clock**: `monotonic` for every delay, the command budgets, the state
  budget and the duty cycle freshness (`earliestAt(mono)` / `dueAt(mono)`
  with the instant handed on), `now` for `/data` only; the test clock moves
  1 µs per read; a real-clock test (×20) measures the period; the stop tests
  run on a real clock and a real TCP Cube.
- **Status and logs**: our own words, error kinds, device kinds and numbers
  in the logs, never a text of the Cube (no serials, names or values); the
  status names the devices (room and name) whose stop was not applied.
- **Gladys 5.1.0 minimum**: `categories`, the thermostat mode / operating
  state types and `text` features are older than that; no `keywords` /
  `countries` yet (they would need 5.3.0, released on 2026-10-25).
