# Build a Hubble module: start here

This page is for anyone outside the Hubble team who wants to connect a new device to
Hubble. You don't need Hubble's source code or a Hubble build of your own.

## What you need

- **A Mac with Hubble.** Download the newest release from
  [Hubble-Releases](https://github.com/Lightlab24/Hubble-Releases/releases/latest).
- **Node.js 22 or newer.** Check with `node --version`.
- **The developer kit.** Open the
  [developer kit releases](https://github.com/Lightlab24/Hubble-Modules/releases?q=developer-kit)
  and download `hubble-module-developer-kit-<version>.tar.gz` from the newest one.
- **Your device's control documentation**, and the device or a simulator of it to test
  against.

## 1. Unpack the kit

```sh
tar -xzf hubble-module-developer-kit-*.tar.gz
cd hubble-module-developer-kit
```

Run the commands below from this folder. Nothing else needs installing.

## 2. Create, build and test your module

```sh
node ./module-tool.mjs create ./my-device my-device
node ./module-tool.mjs build ./my-device
node ./module-tool.mjs test ./my-device
node ./module-tool.mjs validate ./my-device
```

`create` makes a working starter module with a simulated device in place of a real one.
Then change it into yours:

| File                  | What it holds                                                     |
| --------------------- | ----------------------------------------------------------------- |
| `package.json`        | The module's ID, display name and version                         |
| `src/config.ts`       | Its settings, such as the device's IP address                     |
| `src/actions.ts`      | The actions operators put on buttons                              |
| `src/feedback.ts`     | The states it reports back, which light buttons                   |
| `src/instance.ts`     | How it connects to the device and runs each action                |
| `test/module.test.ts` | Tests against the simulated device                                |

Build and test again after each change. The `examples/` folder has working modules for
custom pages, Button Matrix feedback, spreadsheets, sliders and more. Copy from them
freely.

## 3. Try it in Hubble

```sh
node ./module-tool.mjs pack ./my-device my-device-1.0.0.hubble-module
```

1. In HubDash, open **Module Connections** and choose **Add module**.
2. Choose **Import a module file** and pick your `.hubble-module` file.
3. Add your module from the list, fill in its settings, and use its actions on the
   Button Matrix.

After each change, raise `version` in `package.json`, then build, pack and import
again so you can tell the builds apart. For faster turnaround, Hubble can also run your
project folder directly and reload it on request. See
[local tools and handoff](../skills/hubble-module-author/references/workflows.md).

## Using Claude Code

The kit includes a skill that teaches Claude Hubble's module rules. Copy it into your
Claude Code skills folder:

```sh
mkdir -p ~/.claude/skills && cp -R skills/hubble-module-author ~/.claude/skills/
```

Then ask Claude something like "Build a Hubble module for my device" and point it at your
device's documentation.

## 4. Send it in for testing

Pick whichever suits you:

- **Send the file.** Give your `.hubble-module` file to your Hubble contact. They check
  it with `node ./module-tool.mjs inspect <file>`, which doesn't run any of its code,
  then import it as in step 3.
- **Open a submission on GitHub.**
  [Start a Module submission](https://github.com/Lightlab24/Hubble-Modules/issues/new?template=module-submission.yml),
  describe the device and what your module does, and drag in your `.hubble-module` file
  zipped (GitHub only accepts certain file types). Add your source repository and exact
  commit if you have one: an official release needs it.
- **Open a pull request** that adds your project as `submissions/<module-id>/`.
  GitHub builds and tests it automatically.

## Before you send it

- `build`, `test` and `validate` all pass.
- It holds no passwords, keys, real show files or private device logs.
- It sends nothing to the device when it starts or reconnects, only when an operator
  runs an action.
- Its tests use a simulator. Nothing in them needs real equipment or a login.
- Action, feedback and setting IDs stay the same from one version to the next, because
  operators' saved buttons refer to them.
- It says which license it is under, and keeps the license notices of anything it
  includes.

[CONTRIBUTING.md](https://github.com/Lightlab24/Hubble-Modules/blob/main/CONTRIBUTING.md)
has the full review list, and the
[developer guide](developer-kit.md) covers every feature.

## What happens next

The Hubble team reviews the exact file you sent and tests it. Being reviewed doesn't
publish it: adding a module to Hubble's official catalog is a separate, signed step that
the Hubble team takes.
