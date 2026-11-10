import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { connectModuleFrontend } from "@hubble/module-sdk/frontend";
import { RouterView, type RouterPageView } from "./RouterView.js";
import { useRouterState } from "./use-router-state.js";
import { createRouterPageApi } from "./page-client.js";
import {
  ButtonMatrixSettings,
  type ButtonMatrixSettingsBridge,
} from "./ButtonMatrixSettings.js";
import { PreferenceSaveQueue } from "./preference-save-queue.js";
import { initializeRouterZoom } from "./zoom-storage.js";
import { uuid } from "./uuid.js";
import type { ConnectionView } from "./connection-view.js";
import "./page.css";

/** A failure message that fades on its own, like the host's failure toast. */
function useFadingMessage() {
  const [message, setMessage] = useState<string | null>(null);
  const failed = useCallback((next: string) => setMessage(next), []);
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), 7000);
    return () => clearTimeout(timer);
  }, [message]);
  return { message, failed };
}

function RouterPage({
  bridge,
  initial,
  initialAutomaticTake,
  initialView,
}: {
  bridge: ButtonMatrixSettingsBridge;
  initial: ConnectionView;
  initialAutomaticTake: boolean;
  initialView: RouterPageView;
}) {
  const [connection, setConnection] = useState(initial);
  const [revision, setRevision] = useState("initial");
  const [refreshing, setRefreshing] = useState(false);
  const { message, failed } = useFadingMessage();
  useEffect(() => {
    const listener = (event: Event) =>
      failed(String((event as CustomEvent).detail));
    window.addEventListener("router-preference-failure", listener);
    return () =>
      window.removeEventListener("router-preference-failure", listener);
  }, [failed]);
  const [automaticTake, setAutomaticTake] = useState(initialAutomaticTake);
  // The saved value is read once per page load; later choices live in the queue.
  const [automaticTakeQueue] = useState(
    () =>
      new PreferenceSaveQueue(
        initialAutomaticTake,
        (enabled) => bridge.call("set-automatic-take", enabled),
        setAutomaticTake,
        (reason) => failed(`Router page Automatic Take wasn't saved: ${reason}`),
      ),
  );
  // A failed save must not pull the operator off the view they just opened, so
  // it only explains that this choice won't be remembered.
  const viewSaves = useRef<Promise<unknown>>(Promise.resolve());
  const saveView = useCallback(
    (view: RouterPageView) => {
      viewSaves.current = viewSaves.current
        .then(() => bridge.call("set-view", view))
        .catch((error) => failed(`Router page view wasn't saved: ${String(error)}`));
    },
    [bridge, failed],
  );
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
    allowUnassigned: connection.type === "ross-ultrix-ogp",
  });
  return (
    <main className="router-page">
      <details className="router-groups">
        <summary>Button Matrix: Automatic Take and groups</summary>
        <ButtonMatrixSettings
          bridge={bridge}
          revision={revision}
          failed={failed}
        />
      </details>
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
        onRouteFailure={failed}
        initialPageView={initialView}
        onPageViewChange={saveView}
        automaticTake={automaticTake}
        onAutomaticTakeChange={(enabled) => {
          void automaticTakeQueue.set(enabled);
        }}
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

function SettingsPage({ bridge }: { bridge: ButtonMatrixSettingsBridge }) {
  const { message, failed } = useFadingMessage();
  return (
    <main className="button-matrix-settings-page">
      <ButtonMatrixSettings bridge={bridge} failed={failed} />
      {message && (
        <div className="button-matrix-failure" role="alert">
          {message}
        </div>
      )}
    </main>
  );
}

async function start() {
  const element = document.getElementById("root")!;
  const bridge = await connectModuleFrontend(window);
  if (document.documentElement.dataset.view === "settings") {
    const root = createRoot(element);
    root.render(<SettingsPage bridge={bridge} />);
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
    automaticTake?: boolean;
    view?: RouterPageView;
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
  root.render(
    <RouterPage
      bridge={bridge}
      initial={settings.connection}
      initialAutomaticTake={settings.automaticTake === true}
      initialView={settings.view ?? "patch"}
    />,
  );
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
