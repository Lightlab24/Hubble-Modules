import { connectModuleFrontend } from "@hubble/module-sdk/frontend";
import "./frontend.css";

const root = document.querySelector<HTMLElement>("#root")!;
root.innerHTML = `
  <header><h1>Full page example</h1><p>A package-owned header, tabs, scroll area and footer.</p></header>
  <nav role="tablist" aria-label="Package tabs">
    <button id="overview-tab" role="tab" aria-controls="overview" aria-selected="true">Overview</button>
    <button id="activity-tab" role="tab" aria-controls="activity" aria-selected="false">Activity</button>
  </nav>
  <main>
    <section id="overview" role="tabpanel" aria-labelledby="overview-tab"><h2>Long content</h2>${Array.from({ length: 200 }, (_, i) => `<p>Package row ${i + 1}</p>`).join("")}</section>
    <section id="activity" role="tabpanel" aria-labelledby="activity-tab" hidden><h2>Local activity</h2><p id="observations">Waiting for backend state</p></section>
  </main>
  <footer><button id="call" disabled>Call backend</button><output role="status">Connecting…</output></footer>`;
for (const id of ["overview", "activity"]) {
  root
    .querySelector<HTMLButtonElement>(`#${id}-tab`)!
    .addEventListener("click", () => {
      for (const name of ["overview", "activity"]) {
        root.querySelector<HTMLElement>(`#${name}`)!.hidden = name !== id;
        root
          .querySelector(`#${name}-tab`)!
          .setAttribute("aria-selected", String(name === id));
      }
    });
}
const lifetime = new AbortController();
window.addEventListener("pagehide", () => lifetime.abort(), {
  once: true,
});
const status = root.querySelector<HTMLOutputElement>("output")!;
const call = root.querySelector<HTMLButtonElement>("#call")!;
try {
  const bridge = await connectModuleFrontend(window, lifetime.signal);
  lifetime.signal.addEventListener("abort", () => bridge.dispose(), {
    once: true,
  });
  bridge.subscribe((state) => {
    root.querySelector("#observations")!.textContent =
      JSON.stringify(state);
  });
  call.disabled = false;
  status.textContent = "Ready";
  call.addEventListener("click", () => {
    void bridge
      .call("increment")
      .then((reply) => {
        status.textContent =
          reply && typeof reply === "object" && !Array.isArray(reply)
            ? String(reply.message)
            : "Invalid reply";
      })
      .catch((error: unknown) => {
        status.textContent = String(error);
      });
  });
} catch (error) {
  status.textContent = String(error);
}
