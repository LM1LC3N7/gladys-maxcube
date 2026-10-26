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

[Unreleased]: https://github.com/LM1LC3N7/gladys-maxcube/commits/main
