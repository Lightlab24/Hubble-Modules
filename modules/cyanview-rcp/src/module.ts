import { managedModule } from "@hubble/module-runtime-helpers/managed";
import type {
  HubbleModule,
  ModuleActionResult,
  ModuleValues,
} from "@hubble/module-sdk";
import { CyanViewRcpConnectionManager } from "@hubble/protocol-cyanview-rcp";
import { z } from "zod";
import { actionSchemas, type ActionDefinition } from "./actions.js";
import {
  ConnectionDefinitionSchema,
  type ConnectionDefinition,
} from "./config.js";

const recording = new Map([
  ["cyanview-rcp.record-camera", "record-camera"],
  ["cyanview-rcp.record-group-all", "record-group-all"],
  ["cyanview-rcp.start-enabled-cameras", "start-enabled-cameras"],
  ["cyanview-rcp.stop-enabled-cameras", "stop-enabled-cameras"],
]);
const module: HubbleModule = {
  createInstance(context) {
    if (context.scope.kind !== "connection" || !context.modules)
      throw new Error("CyanView RCP requires a connection and module exchange");
    const connectionId = context.scope.connectionId;
    const modules = context.modules;
    const definition = ConnectionDefinitionSchema.parse({
      ...context.settings,
      type: "cyanview-rcp",
      connectionId,
      enabled: true,
      schemaVersion: 1,
    });
    let started = false;
    const selection = managedModule<ConnectionDefinition, ActionDefinition>(
      "cyanview-rcp",
      () => {
        const manager = new CyanViewRcpConnectionManager();
        return {
          start: () => manager.reconcile([definition]),
          stop: () => manager.stop(),
          subscribe: (listener) => manager.subscribe(listener),
          async call(method, value, signal) {
            if (method !== "selectCamera")
              throw new Error("Unsupported selection service");
            await manager.selectCamera(
              connectionId,
              z.int().positive().parse(value),
              signal,
            );
          },
          async execute(action, execution) {
            if (action.type !== "cyanview-rcp.select-camera")
              throw new Error("Recording belongs to CCC");
            await manager.selectCamera(
              connectionId,
              action.cameraNumber,
              execution.signal,
            );
            return { outcome: "success" as const };
          },
        };
      },
      { kind: "response", summary: "RCP acknowledged camera selection" },
      { connection: ConnectionDefinitionSchema, actions: actionSchemas },
    ).createInstance(context);
    const record = async (
      command: string,
      fields: ModuleValues,
      signal: AbortSignal,
    ): Promise<ModuleActionResult> => {
      try {
        if (!started) throw new Error("CyanView RCP is stopped");
        const cameraNumber =
          command === "record-camera"
            ? z.int().min(1).max(999999).parse(fields.cameraNumber)
            : undefined;
        const target = (await modules.discover(signal)).find(
          (item) =>
            item.peer.kind === "host" &&
            item.peer.capabilityId === "ccc" &&
            item.peer.moduleId === "hubble-ccc",
        );
        if (!target?.available)
          throw new Error("Add and enable CCC for shared camera recording");
        if (!target.actionsAllowed)
          throw new Error(
            "Approve this CyanView RCP module to control CCC in Modules → Other modules before recording",
          );
        return await modules.execute(
          target.peer,
          "record-rcp",
          {
            connectionId,
            command,
            ...(cameraNumber === undefined ? {} : { cameraNumber }),
          },
          signal,
        );
      } catch (error) {
        return {
          status: "failure",
          category: signal.aborted ? "cancelled" : "unavailable",
          message: (error instanceof Error
            ? error.message
            : "Recording unavailable"
          ).slice(0, 1000),
        };
      }
    };
    return {
      async start() {
        await selection.start();
        started = true;
        await modules.publish(
          "connection",
          1,
          JSON.parse(JSON.stringify(definition)),
        );
      },
      queryData(query) {
        if (query.id !== "connection" || query.version !== 1)
          throw new Error("Unknown RCP data query");
        return JSON.parse(JSON.stringify(definition));
      },
      execute(id, fields, execution) {
        const command = recording.get(id);
        return command
          ? record(command, fields, execution.signal)
          : selection.execute(id, fields, execution);
      },
      async call(method, value, execution) {
        const command = (
          {
            recordCamera: "record-camera",
            recordGroupAll: "record-group-all",
            startEnabledCameras: "start-enabled-cameras",
            stopEnabledCameras: "stop-enabled-cameras",
          } as Record<string, string>
        )[method];
        if (!command)
          return (await selection.call?.(method, value, execution)) ?? null;
        const result = await record(
          command,
          { cameraNumber: value },
          execution.signal,
        );
        if (result.status === "failure") throw new Error(result.message);
        return null;
      },
      async dispose() {
        started = false;
        await selection.dispose();
      },
    };
  },
};
export default module;
