import { useEffect, useRef, useState } from "react";
import type { createModuleFrontendClient } from "@hubble/module-sdk/frontend";
import type { PageBridge } from "./page-client.js";
import {
  ButtonMatrixSettingsModel,
  MAX_ROUTING_GROUPS,
  followRoutingRevision,
  type ButtonMatrixSettingsRow,
} from "./button-matrix-settings.js";
import { SettingSwitch } from "./SettingSwitch.js";
import { uuid } from "./uuid.js";

type ModuleFrontendClient = ReturnType<typeof createModuleFrontendClient>;
export type ButtonMatrixSettingsBridge = PageBridge &
  Pick<ModuleFrontendClient, "subscribe">;

/**
 * The Button Matrix's Automatic Take and routing groups. Connection settings
 * and the Router page both show this, and both save to the same document.
 */
export function ButtonMatrixSettings({
  bridge,
  failed,
  revision,
}: {
  readonly bridge: ButtonMatrixSettingsBridge;
  readonly failed: (message: string) => void;
  /** Changes when the Router page learns that routing contexts changed. */
  readonly revision?: string;
}) {
  const [rows, setRows] = useState<readonly ButtonMatrixSettingsRow[] | null>(
    null,
  );
  const model = useRef<ButtonMatrixSettingsModel | null>(null);
  const reload = useRef<() => void>(() => {});
  const failedRef = useRef(failed);
  failedRef.current = failed;
  useEffect(() => {
    let live = true;
    const created = new ButtonMatrixSettingsModel(
      bridge,
      (next) => {
        if (live) setRows(next);
      },
      (failure) => {
        if (live) failedRef.current(failure);
      },
      uuid,
    );
    model.current = created;
    reload.current = () =>
      void created.load().catch((error) => {
        if (live) failedRef.current(String(error));
      });
    reload.current();
    // The other screen, or another window, can change the same saved values.
    const stop = bridge.subscribe(followRoutingRevision(() => reload.current()));
    return () => {
      live = false;
      stop();
    };
  }, [bridge]);
  const seenRevision = useRef(revision);
  useEffect(() => {
    if (revision === seenRevision.current) return;
    seenRevision.current = revision;
    reload.current();
  }, [revision]);

  if (rows === null)
    return <p className="button-matrix-note">Loading Button Matrix settings…</p>;
  if (rows.length === 0)
    return (
      <p className="button-matrix-note">
        Add a routing module connection to set its Button Matrix Automatic Take
        and groups.
      </p>
    );
  return (
    <div className="button-matrix-settings">
      {rows.map((row) => (
        <ContextSettings
          key={row.contextId}
          row={row}
          named={rows.length > 1}
          model={model}
        />
      ))}
    </div>
  );
}

function ContextSettings({
  row,
  named,
  model,
}: {
  readonly row: ButtonMatrixSettingsRow;
  readonly named: boolean;
  readonly model: React.RefObject<ButtonMatrixSettingsModel | null>;
}) {
  const prefix = named ? `${row.name}: ` : "";
  return (
    <section
      className="button-matrix-context"
      aria-label={named ? row.name : undefined}
    >
      {named && <h3>{row.name}</h3>}
      <div className="button-matrix-row">
        <div>
          <strong>Automatic Take</strong>
          <span>
            Select SRC buttons route at once. Turn off to hold the selection
            until a Take button. Saves immediately.
          </span>
        </div>
        <SettingSwitch
          label={`${prefix}Button Matrix Automatic Take`}
          checked={row.automaticTake}
          onChange={(enabled) => {
            model.current?.setAutomaticTake(row.contextId, enabled);
          }}
        />
      </div>
      <div className="button-matrix-groups">
        <div className="button-matrix-groups-heading">
          <div>
            <strong>Groups</strong>
            <span>Each group keeps its own source and destination selection.</span>
          </div>
          <span className="button-matrix-count">
            {String(row.groups.length)} / {String(MAX_ROUTING_GROUPS)}
          </span>
        </div>
        {row.groups.length > 0 && (
          <ol aria-label={`${prefix}Routing groups`}>
            {row.groups.map((group) => (
              <GroupName
                key={group.id}
                name={group.name}
                rename={(name) =>
                  model.current?.renameGroup(row.contextId, group.id, name) ??
                  Promise.reject(new Error("Routing settings unavailable"))
                }
                remove={() => {
                  model.current?.deleteGroup(row.contextId, group.id);
                }}
              />
            ))}
          </ol>
        )}
        <button
          type="button"
          disabled={row.groups.length >= MAX_ROUTING_GROUPS}
          onClick={() => {
            model.current?.addGroup(row.contextId);
          }}
        >
          Add group
        </button>
      </div>
    </section>
  );
}

function GroupName({
  name,
  rename,
  remove,
}: {
  readonly name: string;
  readonly rename: (name: string) => Promise<void>;
  readonly remove: () => void;
}) {
  const [draft, setDraft] = useState(name),
    active = useRef(false),
    dirty = useRef(false),
    editVersion = useRef(0);
  useEffect(() => {
    if (!active.current && !dirty.current) setDraft(name);
  }, [name]);
  return (
    <li className="router-group-row">
      <input
        aria-label="Routing group name"
        value={draft}
        onFocus={() => {
          active.current = true;
        }}
        onChange={(event) => {
          dirty.current = true;
          editVersion.current++;
          setDraft(event.target.value);
        }}
        onBlur={() => {
          active.current = false;
          if (!dirty.current) return;
          const version = editVersion.current;
          void rename(draft)
            .then(() => {
              if (version === editVersion.current) {
                dirty.current = false;
                setDraft(draft.trim());
              }
            })
            // A refused name stays in the field so the operator can correct it.
            .catch(() => {});
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
      <button type="button" onClick={remove}>
        Delete group
      </button>
    </li>
  );
}
