import { connectModuleFrontend } from "@hubble/module-sdk/frontend";
import "./frontend.css";
import { installSourcePicker } from "./source-picker.js";

const root = document.getElementById("root")!;
root.innerHTML =
  '<h1>Package canvas</h1><label>Label text <input id="text" value="Camera 1" /></label><button id="render">Render preview</button><canvas width="640" height="80" aria-label="Label preview"></canvas><output aria-live="polite"></output><p id="state" role="status"></p>';
const text = root.querySelector<HTMLInputElement>("input")!;
const button = root.querySelector<HTMLButtonElement>("button")!;
const output = root.querySelector("output")!;
const canvas = root.querySelector("canvas")!;
const state = root.querySelector("#state")!;
button.disabled = true;
try {
  const client = await connectModuleFrontend(window);
  const saved = await client.call("read", null);
  if (saved && typeof saved === "object" && !Array.isArray(saved)) {
    const value = (saved as Record<string, unknown>).value as
      | { design?: { title?: string } }
      | undefined;
    if (typeof value?.design?.title === "string")
      text.value = value.design.title;
  }
  button.disabled = false;
  installSourcePicker(client, root, (result) => {
    if (
      !result ||
      typeof result !== "object" ||
      !("text" in result) ||
      typeof result.text !== "string"
    )
      throw new Error("Invalid linked preview");
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#eee";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#171717";
    ctx.font = "24px sans-serif";
    ctx.fillText(result.text, 16, 48);
    output.textContent = result.text;
  });
  client.subscribe((value) => {
    state.textContent = JSON.stringify(value);
  });
  let issued = 0;
  button.onclick = async () => {
    const sequence = ++issued;
    const draft = text.value;
    const preview = canvas.getContext("2d")!;
    preview.fillStyle = "#eee";
    preview.fillRect(0, 0, canvas.width, canvas.height);
    preview.fillStyle = "#171717";
    preview.font = "24px sans-serif";
    preview.fillText(draft, 16, 48);
    output.textContent = "Saving…";
    try {
      const result = await client.call("render", { text: draft });
      if (sequence !== issued) return;
      if (
        !result ||
        typeof result !== "object" ||
        Array.isArray(result) ||
        typeof result.text !== "string"
      )
        throw new Error("Invalid preview");
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#eee";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#171717";
      ctx.font = "24px sans-serif";
      ctx.fillText(result.text, 16, 48);
      output.textContent = result.text;
    } catch (error) {
      if (sequence === issued)
        output.textContent =
          error instanceof Error ? error.message : "Preview failed";
    }
  };
  window.addEventListener("pagehide", () => client.dispose(), { once: true });
} catch (error) {
  output.textContent =
    error instanceof Error ? error.message : "Page bridge unavailable";
}
