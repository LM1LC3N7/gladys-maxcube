# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- First version, never tested with a real Cube: the eQ-3 MAX! Cube through
  its local TCP port 62910 (one connection, kept open or opened per read),
  ported from the Bouni/max-cube-protocol description and python-maxcube-api.
- Radiator thermostats: temperature (when the Cube gives one), setpoint,
  mode (auto / heating / off), MAX! mode as text, heating state, valve
  opening, battery low, radio link error. Wall thermostats: temperature,
  setpoint, modes, battery, link. Window contacts: open / closed, battery,
  link. The Cube: radio duty cycle and free command slots.
- Commands, off by default: the setpoint (5-30 °C by half degrees within the
  bounds of the device, sent to the room as the MAX! software does) behind
  `allow_setpoint`; the mode (auto, heating, off = manual 4.5 °C) behind
  `allow_mode`. Live values asked to the Cube before acting, 3.5 s budget,
  answer at 4.3 s at most, the Cube read again 5 s later. An off command goes
  first and drops a connection that no longer answers.
- The Cube read every minute, never sooner (a restart included: the time of
  the last read kept in `/data`); pushes of the Cube published at once;
  retries 1 to 10 min; bounded lines, greeting and metadata.
- Button "Test the connection".

### Changed

- Off (the valve closed) needs no option and is never blocked by the bounds
  or the values of the device: it cuts a read in progress, cancels the
  commands of its room not sent yet, and is checked on the reads that follow
  (sent again up to 3 times, then said in the status).
- Commands are checked on the reads 5 s, 30 s, 1 min and 2 min after them;
  only valid values are shown and used; a radio link error hides the cached
  values; a radio budget of 90 % or more refuses the commands other than
  off, and a command queued by the Cube is said so; the command budgets use
  the monotonic clock; a setpoint no longer starts a thermostat that is off
  without "Allow the mode commands"; the bounds and "already set" cover every
  thermostat of the room.
- One unreadable message of a device no longer stops the whole Cube; a
  configuration Gladys cannot give is asked again without end.

[Unreleased]: https://github.com/LM1LC3N7/gladys-maxcube/commits/main
