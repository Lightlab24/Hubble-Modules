# TSL Tally

Official module `hubble-tsl`, version **1.3.0**, using stable Hubble module API **1**.
It receives TSL UMD 3.1 and 5.0 tally over UDP or TCP, shows what a switcher sends, feeds
TALLY Switch and Button Matrix tally feedback, and can set a Ross Carbonite switcher to send
its tally to this computer.

## The page

`TSL Tally` fills the app area (`layout: "full-page"`) with two tabs.

- **Tally** lists every address received, with its name and tally colours, as it changes.
- **Setup** holds every setting of the link in one place:
  - **This computer** is the receiver. These are the module's own settings; the page saves
    them through Hubble (`settings` on the custom section, `module-frontend-settings-v1`),
    which restarts the listener. The page stays open meanwhile (`restart: "keep-open"`,
    `module-frontend-restart-v1`): it then reads everything again and redraws in place,
    leaving the box in use alone. A change made during the restart is saved next. The open
    tab and the last switcher reading are kept in the runtime directory, so they are still
    there after Hubble itself restarts.
  - **Ross switcher** is the one TSL UMD device the switcher keeps for this computer. Its
    settings are saved in the `switcher` document, with the workspace, and reach the
    switcher only on **Send to switcher**.
  - **Match switcher** sets this computer's TSL version, transport and port to what the
    switcher's device sends. **Send to switcher** goes the other way. It sends what the page
    shows for this computer, even when that change is still being saved; a save never runs
    beside a switcher request, because the restart would cut the request short.

## Talking to the switcher

`src/switcher/` speaks binary OGP (TCP 5253), the protocol DashBoard uses, to the switcher's
Ethernet Devices form. It is our own code, written from the protocol as observed on a
Carbonite Ultra 2ME (software 9.2.1); see the comments in `carbonite-devices.ts` for what was
seen on the real switcher and what is still unverified there (editing an existing device,
Enable/Disable, Cancel).

- It writes only the fields of that form (`SWITCHER_WRITABLE_OIDS`), and only for the device
  with this computer's device name. Every other device must read back unchanged.
- It does nothing while someone has the form open in DashBoard.
- Every field is read back before Save; a mismatch cancels the edit.
- The page reaches the switcher only when the operator presses Read switcher, Send to
  switcher or Delete from switcher. Opening the page never does.

## Source ownership

- `src/module.ts` composes the instance: the receiver, Matrix feedback, the published tally
  data and the page. Hubble's own older TSL code still reads the reports the managed helper
  publishes, so the receiver stays wrapped in it.
- `src/receiver.ts` and `src/protocol.ts` are the TSL listener and packet parsing.
- `src/page.ts` is the page's backend; `src/frontend.ts` and `ui/` are the page. `src/setup.ts`
  holds the rules both share: the saved switcher setup and whether the two ends match.
- `src/matrix.ts` and `src/matrix-feedback.ts` own the Button Matrix column.
- `src/manifest.ts` declares actions, feedback, settings, the document and host features.

Existing saved IDs are preserved: settings, actions, feedback, `tally` and `matrix-columns`
data. Saved Button feedback mappings keep working; the page no longer edits them.

## Develop

Run the repository's `pnpm build` once, then `pnpm --filter @hubble-module/tsl build` and
`pnpm --filter @hubble-module/tsl test`.
`pnpm --filter @hubble-module/tsl preview` serves the built page on http://127.0.0.1:43197
against the real backend and a pretend switcher on this computer, with Hubble's shared
control files read from an installed Hubble. `/__simulate` holds or fails saves and makes the
pretend switcher misbehave; `/__inspect` shows what was saved and every write it received.
`pnpm --filter @hubble-module/tsl package` creates the versioned `.hubble-module` artifact.
