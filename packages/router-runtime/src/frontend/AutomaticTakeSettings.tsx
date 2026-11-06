import { useEffect, useRef, useState } from "react";
import type { createModuleFrontendClient } from "@hubble/module-sdk/frontend";
import type { PageBridge } from "./page-client.js";
import {
  AutomaticTakeSettingsModel,
  followRoutingRevision,
  type AutomaticTakeRow,
} from "./automatic-take-settings.js";

type ModuleFrontendClient = ReturnType<typeof createModuleFrontendClient>;

export function AutomaticTakeSettings({
  bridge,
}: {
  bridge: PageBridge & Pick<ModuleFrontendClient, "subscribe">;
}) {
  const [rows, setRows] = useState<readonly AutomaticTakeRow[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const model = useRef<AutomaticTakeSettingsModel | null>(null);
  useEffect(() => {
    let live = true;
    const created = new AutomaticTakeSettingsModel(
      bridge,
      (next) => {
        if (live) setRows(next);
      },
      (failure) => {
        if (live) setMessage(failure);
      },
    );
    model.current = created;
    const reload = () =>
      void created.load().catch((error) => {
        if (live) setMessage(String(error));
      });
    reload();
    // The Router page or another window can change the same saved value.
    const stop = bridge.subscribe(followRoutingRevision(reload));
    return () => {
      live = false;
      stop();
    };
  }, [bridge]);
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), 7000);
    return () => clearTimeout(timer);
  }, [message]);
  return (
    <main className="automatic-take-settings">
      {rows.map((row) => {
        const label =
          rows.length > 1 ? `${row.name}: Automatic Take` : "Automatic Take";
        return (
          <div className="automatic-take-row" key={row.contextId}>
            <div>
              <strong>{label}</strong>
              <span>
                Select SRC routes immediately. Turn off to hold selections until
                Take. Saves immediately.
              </span>
            </div>
            <button
              type="button"
              role="switch"
              aria-label={label}
              aria-checked={row.automaticTake}
              onClick={() => {
                model.current?.setAutomaticTake(
                  row.contextId,
                  !row.automaticTake,
                );
              }}
            >
              <span className="automatic-take-track" aria-hidden="true">
                <span />
              </span>
              <span aria-hidden="true">{row.automaticTake ? "On" : "Off"}</span>
            </button>
          </div>
        );
      })}
      {message && (
        <div className="automatic-take-failure" role="alert">
          {message}
        </div>
      )}
    </main>
  );
}
