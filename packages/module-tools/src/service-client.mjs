#!/usr/bin/env node
import { readFile, realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";

// This source also ships bundled in the authoring kit; no checkout is needed there.

export async function moduleRequest(
  request,
  { url = "http://127.0.0.1:42841", passwordFile, timeoutMs = 30_000 } = {},
) {
  const origin = new URL(url);
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new Error("Use a service origin without credentials or a path");
  const headers = { Origin: origin.origin };
  if (passwordFile) {
    const password = (await readFile(passwordFile, "utf8")).trimEnd();
    headers.Authorization = `Basic ${Buffer.from(`hubble:${password}`).toString("base64")}`;
  }
  const response = await fetch(new URL("/api/session", origin), {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error",
  });
  if (!response.ok)
    throw new Error(`Service session unavailable (${response.status})`);
  const session = await response.json();
  if (typeof session.token !== "string")
    throw new Error("Invalid service session");
  const socketUrl = new URL("/api/socket", origin);
  socketUrl.protocol = origin.protocol === "https:" ? "wss:" : "ws:";
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      socketUrl,
      ["hubble.v1", `hubble.session.${session.token}`],
      {
        headers,
        maxPayload: 40 * 1024 * 1024,
      },
    );
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            "Module operation timed out; inspect current state before retrying",
          ),
        ),
      timeoutMs,
    );
    let done = false;
    function finish(error, value) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolve(value);
    }
    socket.on("open", () =>
      socket.send(
        JSON.stringify({
          kind: "invoke",
          id: 0,
          channel: "hubble:desktop:connect",
          args: [],
        }),
      ),
    );
    socket.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.kind === "result" && message.id === 0) {
          if (!message.ok) {
            finish(new Error("Service subscription was rejected"));
            return;
          }
          socket.send(
            JSON.stringify({
              kind: "invoke",
              id: 1,
              channel: "hubble:desktop:modules",
              args: [request],
            }),
          );
          return;
        }
        if (message.kind === "result" && message.id === 1)
          finish(
            message.ok ? null : new Error("Service rejected the request"),
            message.value,
          );
      } catch {
        finish(new Error("Invalid service response"));
      }
    });
    socket.on("error", () =>
      finish(new Error("Could not connect to the service")),
    );
    socket.on("close", () => {
      if (!done) finish(new Error("Service disconnected before the result"));
    });
  });
}
export async function runServiceTool(args) {
  const options = {};
  const values = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--url") {
      options.url = args[++i];
      continue;
    }
    if (args[i] === "--password-file") {
      options.passwordFile = args[++i];
      continue;
    }
    values.push(args[i]);
  }
  const [operation, ...rest] = values;
  let request;
  if (operation === "request" && rest.length === 1)
    request = JSON.parse(await readFile(rest[0], "utf8"));
  else if (
    ["describe", "list", "check-updates", "cleanup"].includes(operation) &&
    !rest.length
  )
    request = { operation };
  else if (["inspect", "import"].includes(operation) && rest.length === 1)
    request = { operation, path: rest[0] };
  else if (
    ["reload", "logs", "unlink"].includes(operation) &&
    rest.length === 2
  )
    request = { operation, workspaceId: rest[0], connectionId: rest[1] };
  else if (
    ["host-reload", "host-logs", "host-unlink", "host-open-folder"].includes(
      operation,
    ) &&
    rest.length === 2
  )
    request = { operation, workspaceId: rest[0], capabilityId: rest[1] };
  else if (operation === "host-link" && rest.length === 3)
    request = {
      operation,
      workspaceId: rest[0],
      capabilityId: rest[1],
      path: rest[2],
    };
  else if (operation === "reload-all" && rest.length === 1)
    request = { operation, workspaceId: rest[0] };
  else if (operation === "link" && rest.length === 3)
    request = {
      operation,
      workspaceId: rest[0],
      connectionId: rest[1],
      path: rest[2],
    };
  else
    throw new Error(
      "Usage: service-client.mjs [--url ORIGIN] [--password-file PATH] describe|list|check-updates|inspect PATH|import PATH|reload WORKSPACE CONNECTION|reload-all WORKSPACE|logs WORKSPACE CONNECTION|link WORKSPACE CONNECTION PATH|unlink WORKSPACE CONNECTION|host-reload WORKSPACE CAPABILITY|host-logs WORKSPACE CAPABILITY|host-link WORKSPACE CAPABILITY PATH|host-unlink WORKSPACE CAPABILITY|request JSON_FILE",
    );
  return moduleRequest(request, options);
}
const invokedPath = process.argv[1]
  ? await realpath(process.argv[1]).catch(() => null)
  : null;
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  runServiceTool(process.argv.slice(2)).then(
    (result) => {
      console.log(JSON.stringify(result, null, 2));
      if (result.status === "error") process.exitCode = 1;
    },
    (error) => {
      console.error(
        JSON.stringify({ status: "error", message: error.message }),
      );
      process.exitCode = 1;
    },
  );
}
