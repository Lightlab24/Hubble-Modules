# Flanders

Module ID `flanders-monitor`, version 0.2.1. Presses keys on Flanders Scientific (FSI) monitors from
Hubble buttons, the same keys FSI's "Flanders Controls" Stream Deck scripts press. It is a workspace
module: add it once, and its **Flanders** page lists every monitor. It needs Hubble 2.2.0 or later.

## The Flanders page

One row per monitor, on Hubble's shared spreadsheet controls (selection, fill, copy and paste, undo,
the Matrix choice editor, checkboxes, menus, resize, row moves and zoom), the same as Camera Control
and FS-HDR.

| Column | |
| --- | --- |
| Monitor | The name buttons use. Each monitor needs its own. |
| Enabled | Untick to stop keys reaching that monitor. |
| IP address | From the monitor's System menu. A host name works too. Fills down as a series. |
| Port | 18181 unless the monitor says otherwise. |
| When another app is connected | **Don't send the key** (the default) or **Send anyway**. |
| Status | The last thing that happened: *Sent F1*, *F1 held back · Livegrade connected*, *F1 not sent · couldn't connect*, with the time. |

**Add monitor** adds a row; right-click a row to add one above or below or remove it. **Check for
other apps** looks at this Mac's connections for each monitor and shows who is connected, without
contacting any monitor. Monitors are saved in the workspace's `monitor-plan` module document, so they
travel with workspace export and import.

## Buttons

In the Button Matrix, add a Flanders action column. Each row picks a **Monitor** (offered from the
page) and a **Key**. The column opens collapsed to Key; **+** shows Monitor beside it. Elsewhere, use
the **Press key** action with a monitor and key. The monitor reports nothing back, so a key has no
feedback colour.

Keys: SDI 1 to SDI 4, F1 to F5, Menu, Up, Down, Enter, Volume up, Volume down and Mute. FSI
publishes these for XMP series monitors. Each key is one 12-byte packet to the monitor's control
port. The packet's checksum is CRC-16/X-25, so the module builds every packet itself and they match
FSI's scripts byte for byte.

## Not interrupting other apps

LiveGrade and FSI's IP Remote Utility keep a connection open to the same port, and FSI warns that a
second connection may interrupt them. Two things keep Hubble out of their way:

- **Nothing stays connected.** Hubble opens a connection only to send a key, then closes it and
  waits for the socket to go. It never connects at start-up and never polls. Keys to one monitor
  go one at a time.
- **It checks first.** Before each key Hubble reads this Mac's own connection list. If another app
  on this Mac is connected to that monitor and port, the key isn't sent and the result names the
  app. A monitor set to **Send anyway** skips the check.

Hubble can only see apps on its own Mac. An app on another computer connected to the same monitor
isn't detected. How a monitor treats a second connection isn't documented: if it drops the first
one, Send anyway, or an app on another computer, will interrupt that app.

## Testing without a monitor

`tools/fake-monitor.ts` is a stand-in monitor on loopback that prints each key it receives:

```sh
node_modules/.bin/tsx modules/flanders-monitor/tools/fake-monitor.ts 18181
```

Point a monitor row at `127.0.0.1`. The tests use the same fake, a real `netstat`, a separate process
holding the port to stand in for LiveGrade, and a document store that holds saves to check edits
show at once, a second edit while the first save waits, and recovery when a save fails.
