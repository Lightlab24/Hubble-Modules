# FS-HDR Simulator

The simulator runs a virtual AJA FS-HDR for testing Hubble, FS-HDR Control Hub, and REST clients without a hardware unit. Its firmware 4.3.2.5 profile includes 4,090 parameter descriptors and 99 mapped controls. It supports HD/SD four-channel and 4K/UHD single-channel operation.

Source and review are in the private `Lightlab24/FSHDR-Control-Hub` repository. [Pull request #1](https://github.com/Lightlab24/FSHDR-Control-Hub/pull/1) · [Simulator README and API examples](https://github.com/Lightlab24/FSHDR-Control-Hub/blob/codex/fs-hdr-simulator/simulator/README.md)

## Start the simulator

Use Node.js 22 or newer. From the root of the `codex/fs-hdr-simulator` checkout or the local `FSHDR_Capture` workspace, run:

```sh
node simulator/server.mjs
```

Open [the simulator console](http://127.0.0.1:8080). Use separate ports and state files to run independent units. The `--state` option saves settings, preset banks, and LUT slot metadata across restarts.

```sh
node simulator/server.mjs --port 8081 --name 'FS-HDR Bench A' --mode four --state bench-a.state.json
node simulator/server.mjs --port 8082 --name 'FS-HDR Bench B' --mode single --state bench-b.state.json
```

## Connect a client

| Client | Setup on the simulator host |
| --- | --- |
| Hubble | In **FS-HDR → Setup**, add `http://127.0.0.1:8080`, select **Monitor and control**, and save. |
| FS-HDR Control Hub | Enter `127.0.0.1:8080` in the device's IP field. |
| REST client | Use `/desc.json` and `/map.json` for discovery and `/config` for reads, writes, and long polling. [Local API reference](http://127.0.0.1:8080/rest.tmpl) |

Use the port for the unit you started. For a client on another machine, see the shared-bench binding and token settings in the [simulator README](https://github.com/Lightlab24/FSHDR-Control-Hub/blob/codex/fs-hdr-simulator/simulator/README.md).

## Exercise a workflow

1. In **Signal & I/O**, click **Restore signal** and change a processor's HDR transform. Confirm the client receives the update.
2. In **Parameters**, search by name or `eParamID_…`. Enable a prerequisite such as **Color Corrector**, edit a mapped gain, and confirm the new value in the client.
3. In **Presets & LUTs**, store and recall a preset in the current mode or upload a 33-point `.cube` file to a User LUT slot.
4. Use **Expire subscriptions** to test reconnect. Set **Next remote write** to **Acknowledge without applying** to test how the client reports a write that fails readback.

## Coverage and verification

The simulator models video and audio settings, signal status, alarms, and contact I/O. LUT uploads validate the cube and retain slot metadata. Preset imports use the simulator's JSON format. Physical media processing, Dynamic LUT payload transfer, and firmware installation are outside its scope.

All seven simulator tests passed. Smoke checks exercised the browser console, the Hubble FS-HDR client, the Control Hub Swift networking code, and the capture inspector.

```sh
node --test simulator/test/*.test.mjs
```
