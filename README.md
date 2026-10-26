# gladys-maxcube

[Gladys Assistant](https://gladysassistant.com) external integration for the
**eQ-3 MAX! Cube** through its local TCP port (62910): the **radiator
thermostats** (temperature, setpoint, mode, valve, battery), the **wall
thermostats** (temperature, setpoint, mode) and the **window contacts**
(open / closed), plus the radio duty cycle of the Cube. The setpoint and the
mode can be commanded, each behind an option off by default. Local, no cloud.
**Unofficial integration, not affiliated with eQ-3. Never tested with a
real Cube yet.**

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (MaxCubeApp)
                 ├─ src/cube/client.js    the one TCP connection: lines, greeting, l: / s: exchanges, pushes
                 ├─ src/cube/protocol.js  H, M, C, L, S messages and the s command (ported from the protocol doc)
                 ├─ src/devices.js        devices and states (pure)
                 ├─ src/budget.js         states per minute
                 └─ src/store.js          /data: the time of the last read
```

- **Cube**: a TCP connection to port 62910. The Cube greets it with `H:`
  (serial, firmware, duty cycle), `M:` (rooms and devices, base64), one `C:`
  per device (comfort / eco / min / max temperatures) and `L:` (the live
  values). `l:` asks for `L:` again every minute (the cache of the Cube, no
  radio); `s:` sends command 40 (temperature and mode) and is answered by
  `S:<duty cycle>,<result>,<free slots>`; `q:` closes. Nothing else is ever
  written (no reset, no pairing, no factory command). One connection, kept
  (default) or opened per read (`keep_connection` off), since a Cube accepts
  one client. External ids are the serial numbers: `cube:<serial>`,
  `thermostat:<serial>`, `wall:<serial>`, `window:<serial>`.
- **Bounds**: a line of 16 KiB at most, a greeting of 200 lines / 256 KiB,
  100 devices and rooms, 20 metadata blocks; every index into a decoded
  message is checked; a configuration or a list entry of one device that
  cannot be read leaves that device without values, the others are read;
  the logs hold none of what the Cube sends (only our words, device kinds
  and numbers). Values are shown only from valid, initialized entries
  without a radio link error.
- **Commands**, all to the room as the MAX! software does. **Off** (manual
  4.5 °C, the valve closed) is protective: no option, identity only, always
  sent; it cuts a read in flight (a new connection), cancels the commands of
  its room not written yet, waits only for the answer to a command already
  written, and is checked on the follow-up reads (sent again up to 3 times).
  The setpoint (`allow_setpoint`: 5-30 °C by half degrees within the bounds
  of every thermostat of the room) and auto / heating (`allow_mode`) are off
  by default; they are decided on the live values asked just before, refused
  on values not valid, on a radio budget of 90 % or more, and (a setpoint)
  on a thermostat that is off without `allow_mode`. Budgets on the monotonic
  clock: nothing written past 3.5 s after the arrival, Gladys answered at
  most 4.3 s after it; follow-up reads 5 s, 30 s, 1 min and 2 min later.
- **Clock**: one read of the monotonic clock per decision (`dueAt(mono)`);
  the loop never reads sooner than the interval (a restart included: the
  time of the last attempt is kept in `/data`), the reads that follow a
  command apart; retries 1 to 10 min; heartbeat 10 min; at
  most 250 states a minute.
- **Reconnection to Gladys**: status, Discovery, states and badges are
  published again; the connection to the Cube stays. A device republished
  never loses a feature of the created one, nor changes its shape.

## Development

```bash
npm install
npm test                                        # node --test, no network (loopback only)
npm run lint && npm run format:check
npm run audit                                   # production dependencies
npm run cover                                   # regenerate cover.png
npx github:GladysAssistant/integration-store .  # store admission checks
```

The tests run against the SDK's fake Gladys and a fake Cube (the messages of
the protocol documentation and our own encoders), a real local TCP server
for the connection and a real-clock test of the reading loop. No test touches
a real Cube or the Internet.

## Credits

- [Bouni/max-cube-protocol](https://github.com/Bouni/max-cube-protocol) (MIT):
  the description of the protocol.
- [hackercowboy/python-maxcube-api](https://github.com/hackercowboy/python-maxcube-api)
  (MIT): the library of the Home Assistant `maxcube` integration, whose logic
  is ported here. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- The structure follows [gladys-plugwise](https://github.com/LM1LC3N7/gladys-plugwise)
  and [gladys-iskra](https://github.com/LM1LC3N7/gladys-iskra) by the same author.

Licensed under the Apache License 2.0 (see [LICENSE](LICENSE)).
