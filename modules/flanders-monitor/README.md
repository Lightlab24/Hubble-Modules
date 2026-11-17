# Flanders

Module ID `flanders-monitor`, version 0.1.0. Presses keys on Flanders Scientific (FSI) monitors from
Hubble buttons, the same keys FSI's "Flanders Controls" Stream Deck scripts press. It needs Hubble
2.2.0 or later.

## Keys

SDI 1 to SDI 4, F1 to F5, Menu, Up, Down, Enter, Volume up, Volume down and Mute. FSI publishes these
for XMP series monitors. Each key is one 12-byte packet to the monitor's control port, 18181. The
packet's checksum is CRC-16/X-25, so the module builds every packet itself and they match FSI's
scripts byte for byte.

In the Button Matrix, add an action column for the Flanders connection and pick a key in each row's
**Key** cell. Elsewhere, use the **Press key** action. The monitor reports nothing back, so a key has
no feedback colour.

## Not interrupting other apps

LiveGrade and FSI's IP Remote Utility keep a connection open to the same port, and FSI warns that a
second connection may interrupt them. Two things keep Hubble out of their way:

- **Nothing stays connected.** Hubble opens a connection only to send a key, then closes it and
  waits for the socket to go, usually within a few milliseconds. It never connects at start-up and
  never polls. Keys to one monitor go one at a time.
- **It checks first.** Before each key Hubble reads this Mac's own connection list. If another app
  on this Mac is connected to that monitor and port, the key isn't sent and the result names the app,
  for example "Livegrade is connected to this monitor, so F1 wasn't sent." Set **When another app is
  connected** to **Send anyway** to send regardless.

Hubble can only see apps on its own Mac. An app on another computer connected to the same monitor
isn't detected. How a monitor treats a second connection isn't documented: if it drops the first
one, Send anyway, or an app on another computer, will interrupt that app.

## Settings

| Setting | Default | |
| --- | --- | --- |
| Monitor IP address | blank | From the monitor's System menu. A host name works too. |
| Port | 18181 | |
| When another app is connected | Don't send the key | Or Send anyway. |

## Testing without a monitor

`tools/fake-monitor.ts` is a stand-in monitor on loopback that prints each key it receives:

```sh
node_modules/.bin/tsx modules/flanders-monitor/tools/fake-monitor.ts 18181
```

Point a Flanders connection at `127.0.0.1`. The tests use the same fake, a real `netstat`, and a
separate process holding the port to stand in for LiveGrade.
