import { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { connectModuleFrontend } from "@hubble/module-sdk/frontend";
import { RouterView } from "./RouterView.js";
import { useRouterState } from "./use-router-state.js";
import { createRouterPageApi, type PageBridge } from "./page-client.js";
import { GroupPanel } from "./GroupPanel.js";
import { AutomaticTakeSettings } from "./AutomaticTakeSettings.js";
import { initializeRouterZoom } from "./zoom-storage.js";
import { uuid } from "./uuid.js";
import type { ConnectionView } from "./connection-view.js";
import "./page.css";

function RouterPage({
  bridge,
  initial,
}: {
  bridge: PageBridge;
  initial: ConnectionView;
}) {
  const [connection, setConnection] = useState(initial);
  const [revision, setRevision] = useState("initial");
  const [message, setMessage] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const failed = useCallback((message: string) => setMessage(message), []);
  useEffect(() => {
    const listener = (event: Event) =>
      failed(String((event as CustomEvent).detail));
    window.addEventListener("router-preference-failure", listener);
    return () =>
      window.removeEventListener("router-preference-failure", listener);
  }, [failed]);
  useEffect(() => {
    if (message) {
      const timer = setTimeout(() => setMessage(null), 7000);
      return () => clearTimeout(timer);
    }
  }, [message]);
  const api = useMemo(
    () =>
      createRouterPageApi(bridge, (next, revision) => {
        setConnection(next);
        if (revision) setRevision(revision);
      }),
    [bridge],
  );
  const router = useRouterState(api, true, connection.connectionId, {
    randomUUID: uuid,
  });
  return (
    <main className="router-page">
      <GroupPanel bridge={bridge} revision={revision} failed={failed} />
      {message && (
        <div className="router-failure" role="alert">
          {message}
        </div>
      )}
      <RouterView
        connections={[connection]}
        selectedConnectionId={connection.connectionId}
        onConnectionChange={() => {}}
        router={router}
        refreshingRouterNames={refreshing}
        onRefreshRouterNames={() => {
          setRefreshing(true);
          void bridge
            .call("refresh")
            .catch((error) => failed(String(error)))
            .finally(() => setRefreshing(false));
        }}
      />
    </main>
  );
}

async function start() {
  const element = document.getElementById("root")!;
  const bridge = await connectModuleFrontend(window);
  if (document.documentElement.dataset.view === "settings") {
    const root = createRoot(element);
    root.render(<AutomaticTakeSettings bridge={bridge} />);
    window.addEventListener(
      "pagehide",
      () => {
        root.unmount();
        bridge.dispose();
      },
      { once: true },
    );
    return;
  }
  const settings = (await bridge.call("settings")) as unknown as {
    connection: ConnectionView;
    zoom: number;
  };
  let zoomTail: Promise<unknown> = Promise.resolve();
  initializeRouterZoom(
    JSON.stringify({ version: 1, zoom: settings.zoom }),
    (value) => {
      const zoom: unknown = JSON.parse(value).zoom;
      zoomTail = zoomTail
        .then(() => bridge.call("set-zoom", zoom as number))
        .catch((error) => {
          // Keep the current visual preference usable; explain failed persistence.
          window.dispatchEvent(
            new CustomEvent("router-preference-failure", {
              detail: String(error),
            }),
          );
        });
    },
  );
  const root = createRoot(element);
  root.render(<RouterPage bridge={bridge} initial={settings.connection} />);
  window.addEventListener(
    "pagehide",
    () => {
      root.unmount();
      bridge.dispose();
    },
    { once: true },
  );
}
void start().catch((error) => {
  document.getElementById("root")!.textContent =
    `Router page unavailable: ${String(error)}`;
});
