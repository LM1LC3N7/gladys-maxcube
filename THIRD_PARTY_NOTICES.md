# Third-party notices

This integration ports to JavaScript the logic of the projects below for
talking to an eQ-3 MAX! Cube. Nothing of them is installed at runtime: one
is a documentation, the other is Python, this integration is JavaScript.

## Bouni/max-cube-protocol

<https://github.com/Bouni/max-cube-protocol> (read on 2026-10-25), the
description of the protocol of the MAX! Cube, licensed under the MIT License.

Ported in `src/cube/protocol.js`: the line format (`X:<argument>`, CR LF),
the fields of the H message (serial, RF address, firmware, duty cycle, free
memory slots), the layout of the M message (rooms and devices, base64 blocks),
of the C message (the first 18 bytes and the comfort / eco / max / min
temperatures of the thermostats), of the L message (the entry length, the RF
address, the two flag bytes, the valve position, the setpoint, the room
temperature of the radiator and wall thermostats, the window state), of the
S answer (duty cycle, result, free slots) and of the s command 40
(temperature and mode). The messages of its examples are used as test data
(`test/fixtures/cube.js`).

```
The MIT License (MIT)

Copyright (c) 2013 bouni

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## hackercowboy/python-maxcube-api

<https://github.com/hackercowboy/python-maxcube-api> (version 0.4.3, read
on 2026-10-25), the library of the Home Assistant `maxcube` integration,
licensed under the MIT License.

Ported in `src/cube/client.js`, `src/cube/protocol.js` and `src/app.js`: the
connection and its greeting awaited up to the L message, the `l:` and `s:`
exchanges and their timeouts, the unsolicited messages (an L pushed by the
Cube), the `q:` on close, the persistent connection and its release, the
parsing of the H, M, C and L messages (device types, modes, battery, valve,
target and actual temperatures, window state), the building of the s command
40 (`00 <rf flag> 40 000000 <rf address> <room> <mode << 6 | temp * 2>`, the
room flag), the interpretation of the S answer (result 0 processed, 1
discarded, duty cycle and free slots), and the setpoint / mode semantics
(auto with temperature 0 back to the programme, manual, off at 4.5 °C).

```
The MIT License (MIT)

Copyright (c) 2015 David Übelacker

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

(The copyright lines are the ones of the projects' own LICENSE files,
reproduced as they are.)

## LM1LC3N7/gladys-plugwise, LM1LC3N7/gladys-iskra and LM1LC3N7/gladys-coolmasternet

The `/data` store, the states budget, the structure of the app, the handler
wiring, the retry policy, the command checks, the clock model and the bounded
TCP line reading follow integrations of the same author, under the Apache
License 2.0 of this repository.
