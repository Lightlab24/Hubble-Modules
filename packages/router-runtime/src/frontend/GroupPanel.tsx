import { useEffect, useRef, useState } from "react";
import { GroupPageSchema, type GroupPage } from "../group-page.js";
import type { PageBridge } from "./page-client.js";
import { uuid } from "./uuid.js";
import { GroupEditQueue } from "./group-edit-queue.js";

export function GroupPanel({
  bridge,
  revision,
  failed,
}: {
  bridge: PageBridge;
  revision: string;
  failed: (message: string) => void;
}) {
  const [page, setPage] = useState<GroupPage>({
    contexts: [],
    contextId: null,
    groups: [],
    automaticTake: true,
  });
  const [selected, setSelected] = useState<string | null>(null);
  const queues = useRef(new Map<string, GroupEditQueue>());
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  useEffect(() => {
    let live = true;
    const queue = selected ? queues.current.get(selected) : undefined;
    const epoch = queue?.readEpoch ?? 0;
    if (queue?.busy) return;
    void bridge
      .call("groups", selected)
      .then((value) => {
        if (!live) return;
        const next = GroupPageSchema.parse(value);
        if (next.contextId && !queues.current.has(next.contextId)) {
          const id = next.contextId;
          queues.current.set(
            id,
            new GroupEditQueue(
              next,
              async (input) =>
                GroupPageSchema.parse(await bridge.call("edit-group", input)),
              (value) => {
                if (selectedRef.current === id) setPage(value);
              },
              failed,
            ),
          );
        }
        if (queue && next.contextId === selected) queue.refresh(next, epoch);
        else setPage(next);
        if (selected !== next.contextId) setSelected(next.contextId);
      })
      .catch((error) => {
        if (live) failed(String(error));
      });
    return () => {
      live = false;
    };
  }, [bridge, revision, selected, failed]);
  const queue = page.contextId ? queues.current.get(page.contextId) : undefined;
  return (
    <details className="router-groups">
      <summary>Routing groups and automatic take</summary>
      <label>
        Routing module{" "}
        <select
          value={selected ?? ""}
          onChange={(event) => {
            const id = event.target.value;
            setSelected(id);
            setPage(
              queues.current.get(id)?.snapshot ?? {
                contexts: page.contexts,
                contextId: id,
                groups: [],
                automaticTake: true,
              },
            );
          }}
        >
          {page.contexts.map((item) => (
            <option key={item.contextId} value={item.contextId}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        <input
          type="checkbox"
          checked={page.automaticTake}
          disabled={!queue}
          onChange={(event) => {
            if (page.contextId)
              void queue
                ?.edit({
                  operation: "automatic-take",
                  contextId: page.contextId,
                  enabled: event.target.checked,
                })
                .catch(() => {});
          }}
        />{" "}
        Automatic take
      </label>
      <p>
        Automatic take routes a selected source immediately. With it off, select
        a source and destination, then press Take.
      </p>
      {page.groups.map((group) => (
        <GroupName
          key={`${page.contextId}:${group.id}`}
          name={group.name}
          rename={(name) =>
            page.contextId && queue
              ? queue.edit({
                  operation: "rename",
                  contextId: page.contextId,
                  id: group.id,
                  name,
                })
              : Promise.reject(new Error("Routing context changed"))
          }
          remove={() => {
            if (page.contextId)
              void queue
                ?.edit({
                  operation: "delete",
                  contextId: page.contextId,
                  id: group.id,
                })
                .catch(() => {});
          }}
        />
      ))}
      <button
        disabled={!queue || page.groups.length >= 64}
        onClick={() => {
          if (!page.contextId) return;
          let index = 1;
          while (
            page.groups.some(
              (item) => item.name.toLowerCase() === `group ${index}`,
            )
          )
            index++;
          void queue
            ?.edit({
              operation: "add",
              contextId: page.contextId,
              id: uuid(),
              name: `Group ${index}`,
            })
            .catch(() => {});
        }}
      >
        Add group
      </button>
      {!page.contextId && (
        <p>Add a routing module connection to configure its groups.</p>
      )}
    </details>
  );
}
function GroupName({
  name,
  rename,
  remove,
}: {
  name: string;
  rename: (name: string) => Promise<void>;
  remove: () => void;
}) {
  const [draft, setDraft] = useState(name),
    active = useRef(false),
    dirty = useRef(false),
    editVersion = useRef(0);
  useEffect(() => {
    if (!active.current && !dirty.current) setDraft(name);
  }, [name]);
  return (
    <div className="router-group-row">
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
          if (dirty.current) {
            const version = editVersion.current;
            void rename(draft)
              .then(() => {
                if (version === editVersion.current) {
                  dirty.current = false;
                  setDraft(draft.trim());
                }
              })
              .catch(() => {});
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
      <button onClick={remove}>Delete group</button>
    </div>
  );
}
