# MAX! Cube (eQ-3)

Your **eQ-3 MAX!** heating system in Gladys, through the local port of the
**MAX! Cube** (TCP 62910) on your network, without any cloud:

- **radiator thermostats** (MAX! Heating Thermostat and Thermostat+): room
  **temperature** (when the Cube gives one), **setpoint**, **mode** (auto,
  heating, off), **MAX! mode** (auto, manual, vacation, boost), **heating
  state** and **valve opening** (%), **battery low**, **radio link error**;
- **wall thermostats** (MAX! Wall Thermostat): **temperature**, **setpoint**,
  **mode**, **MAX! mode**, battery, link;
- **window contacts** (MAX! Shutter Contact): **open / closed**, battery,
  link;
- the **Cube** itself: **radio duty cycle** (%) and **free command slots**.

> **This integration has never been tested with a real Cube.** This first
> version was written from the protocol description (Bouni/max-cube-protocol)
> and the python-maxcube-api library (the one of Home Assistant), and tested
> only against a fake Cube. Say on the Gladys forum what works and what does
> not.

Unofficial integration, not affiliated with eQ-3. The MAX! hardware is no
longer made, but it remains widely installed; the eQ-3 portal is not used.

## What you need

- A **MAX! Cube** (the LAN gateway) on your network, with its devices already
  paired and sorted by room in the MAX! software (the names of the rooms and
  devices come from there). Push buttons (MAX! Eco Switch) are ignored.
- A Cube accepts **one client at a time**. By default, Gladys keeps its
  connection open: the MAX! software cannot connect meanwhile. Untick **Keep
  the connection open** so that Gladys only opens a connection for the time
  of a read or a command; the MAX! software can then connect between two
  reads.

## Configuration

- **Cube address**: its IP address on your network (`192.168.1.40`), shown by
  your router or the MAX! software; a port may follow (62910 by default).
  Prefer the IP address: a `.local` name (mDNS) does not resolve inside the
  container of the integration. Give the Cube a fixed address in your router;
  if it changes, type the new one: the devices and their history are kept
  (they are known by their serial numbers). No password: the Cube asks for
  none on its local port.
- **Allow the setpoint commands** and **Allow the mode commands**: off by
  default (see Commands).
- **Keep the connection open**: ticked by default (see above).
- **Language of the devices**: French (default) or English.

Then open the **Discover** tab and create the devices to follow. The devices
are named `Room - Name` after the MAX! software. The **Test the connection**
button reads the Cube and lists what it shows; it never reads the Cube again
less than a minute after the previous read (it then shows the last read), but
it does not wait for the retry pause after a failure.

## Readings

- The Cube is read every **minute** (its own memory, no radio traffic: the
  MAX! devices report to the Cube at their own pace, and the Cube keeps their
  last values). With the connection kept open, a device that reports to the
  Cube is shown at once. Only the values that change are sent to Gladys (and
  each one at least every 10 minutes).
- The **temperature** of a radiator thermostat is only given by the Cube now
  and then (when the valve moves, in auto or manual mode); the one of a wall
  thermostat always is. A device the Cube has not heard yet (no values) shows
  as **unreachable** and the status says so.
- The **mode** follows the modes of Gladys: **auto** (3) when the thermostat
  follows its weekly programme, **heating** (1) in manual, boost or vacation,
  **off** (0) when the setpoint is 4.5 °C (valve closed). The **MAX! mode**
  (text: `auto`, `manual`, `vacation`, `boost`) gives the detail.
- The window contact is **1 closed, 0 open** (the opening sensor of Gladys).
- The names of the rooms and devices are read again at each new connection
  (every 6 hours at the latest with the connection kept).

## Commands

By default, Gladys only **reads**. Once an option is ticked, the dashboard,
the scenes, the voice assistants (Siri / HomeKit, Alexa, Google Home) and the
Thermostat service of Gladys can act.

- **Allow the setpoint commands**: the **setpoint** of a radiator or wall
  thermostat, **5 to 30 °C**, rounded to the half degree (the resolution of
  the thermostat), within the bounds set on the device (the Cube gives them);
  a value outside is refused, never brought back into the bounds. In auto
  mode, the setpoint holds until the next switch point of the weekly
  programme; otherwise it puts the thermostat in manual (a boost or a
  vacation under way ends). As the MAX! software does, the setpoint is sent
  to the **whole room** of the thermostat (the thermostats of a room are
  linked together).
- **Allow the mode commands**:
  - **auto** (3): back to the weekly programme of the device;
  - **heating** (1): manual at the current setpoint, or at the comfort
    temperature set on the device when the valve was closed (refused when the
    Cube does not give it);
  - **off** (0): manual at 4.5 °C, the "off" setpoint of MAX! (valve closed).
    The thermostat applies its own frost protection as described by eQ-3:
    check the manual of your device before leaving a radiator off in winter;
  - **cooling** (2): refused, a MAX! thermostat does not cool.
- Just before acting, Gladys **asks the Cube for its live values** and
  decides on that read only. A command is **not sent** when: the option is
  unticked (checked when the command arrives and again just before sending);
  the value is not a number from 5 to 30 °C, or the mode is not 0, 1 or 3;
  the device is no longer paired with the Cube; the Cube has no values for it
  yet (not heard over the radio); the bounds of the device leave no valid
  value; the read fails (no answer within 2.7 s, connection closed); the
  configuration changed meanwhile; or the value asked is already the one the
  Cube holds (nothing to do, the command is acknowledged).
- When the command cannot be checked within 3.5 s, nothing is sent and Gladys
  shows a failure. Once sent, Gladys answers at most 4.3 s after your command:
  "accepted by the Cube" when the Cube answered that it passes it over the
  radio, "sent, without confirmation" when it has not answered yet,
  "discarded" when it discarded it (the radio budget of the hour is used up,
  or no free slot: the status of the integration shows it). The Cube does not
  confirm that the thermostat applied the command: the thermostat applies it
  when it listens to the Cube (usually within the minute). The Cube is read
  again 5 s after each command sent, then every minute; the value shown is
  always the one the Cube gives, never the one asked.
- The commands run one after the other (one Cube, one connection). An **off**
  command goes before the other commands waiting; when the connection to the
  Cube no longer answers (an exchange without answer for 2.5 s), it drops it
  and opens a new one. It remains subject to the **Allow the mode commands**
  option and to the refusals listed above.
- The radio budget of the Cube (1 % of the time per hour, in Europe) limits
  the number of commands per hour; the status of the integration warns from
  80 %.
- The weekly programme, the boost, the vacation mode, the comfort and eco
  temperatures, the temperature offset and the pairing stay in the MAX!
  software.

## Connection problems

- **Cube unreachable** or not answering: every device shows as unreachable;
  new try after 1 min, then less and less often up to every 10 min (never
  faster than the normal read). The most common cause: another client (the
  MAX! software, another integration) holds the connection of the Cube.
- **This address does not answer like a MAX! Cube**: the address or the port
  (62910) is wrong, or another service answers.
- After a restart of the integration, the Cube is never read again less than
  a minute after the previous read (the time of the last read is kept in
  `/data`).
- The logs hold nothing of what the Cube sends (no serial numbers, names or
  values), only our own words (no connection, no answer in time...).

## Limits

- One Cube per integration.
- No boost, vacation mode, weekly programme, comfort / eco temperatures,
  pairing or removal of devices from Gladys.
- Push buttons (Eco Switch) are not published.
- Never tested with a real Cube.
