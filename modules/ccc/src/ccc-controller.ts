import { randomUUID } from "node:crypto";
import {
  EMPTY_CCC,
  normalizeCccIp,
  cccTargetKey,
  cccCommandNeedsCamera,
  cccCommandControlsRecording,
  type CccCommand,
  type CccBatchResult,
  type CccCommandRequest,
  type CccConfig,
  type CccMutationRequest,
  type CccResult,
  type CccRow,
  type CccState,
  CyanViewRcpConnectionDefinitionSchema,
  type CyanViewRcpConnectionDefinition,
} from "./config.js";
import {
  RcpSession,
  type CyanViewCameraTarget,
  type CyanViewCameraParameterStep,
} from "./rcp-session.js";
import {
  RecordingCoordinator,
  type RecordingResult,
} from "./recording-coordinator.js";
import type { ModuleJsonValue as JsonValue } from "@hubble/module-sdk";
import type { RecordingBatchResult as ModuleActionResult } from "./recording-result.js";

const PARAMETER_STEPS = new Map<CccCommand, CyanViewCameraParameterStep>([
  ["nd-up-enabled-cameras", { parameter: "nd_filter", direction: "next" }],
  ["nd-down-enabled-cameras", { parameter: "nd_filter", direction: "prev" }],
  ["iso-up-enabled-cameras", { parameter: "master_gain", direction: "next" }],
  ["iso-down-enabled-cameras", { parameter: "master_gain", direction: "prev" }],
  [
    "base-gain-up-enabled-cameras",
    { parameter: "gain_mode", direction: "next" },
  ],
  [
    "base-gain-down-enabled-cameras",
    { parameter: "gain_mode", direction: "prev" },
  ],
]);

export interface CccStore {
  read(workspaceId: string): Promise<CccConfig>;
  mutate(request: CccMutationRequest): Promise<CccConfig>;
}
interface ConnectionEntry {
  readonly session: RcpSession;
  readonly transport: string;
  retiring: boolean;
  leases: number;
}
interface CapturedTarget {
  readonly row: CccRow;
  readonly epoch: number;
  readonly entry?: ConnectionEntry;
  readonly target?: CyanViewCameraTarget;
  readonly error?: string;
}

/** One selection authority for the spreadsheet, matrix, Companion and Stream Deck. */
export class CccController {
  private workspaceId = "";
  private config: CccConfig = EMPTY_CCC;
  private readonly entries = new Map<string, ConnectionEntry>();
  private readonly results = new Map<string, CccResult>();
  private readonly listeners = new Set<() => void>();
  private acceptance: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private nextEpoch = 0;
  private readonly epochs = new Map<string, number>();
  private readonly consumers = new Map<
    string,
    CyanViewRcpConnectionDefinition
  >();
  private connectorEnabled = true;
  readonly recording: RecordingCoordinator;

  constructor(
    private readonly store: CccStore,
    feedbackTimeoutMs = 1500,
    private readonly createSession = (
      definition: CyanViewRcpConnectionDefinition,
      changed: () => void,
    ): RcpSession =>
      new RcpSession(
        CyanViewRcpConnectionDefinitionSchema.parse(definition),
        changed,
        true,
      ),
    recovery: "initial" | "clean" | "unclean" = "initial",
    checkpoint?: JsonValue,
  ) {
    this.recording = new RecordingCoordinator({
      feedbackTimeoutMs,
      recovery,
      ...(checkpoint === undefined ? {} : { checkpoint }),
      changed: () => {
        this.emit();
      },
    });
  }

  activate(workspaceId: string): Promise<void> {
    return this.serialize(async () => {
      const config = await this.store.read(workspaceId);
      if (workspaceId !== this.workspaceId) {
        this.results.clear();
        this.epochs.clear();
      }
      this.workspaceId = workspaceId;
      this.adopt(config);
    });
  }

  state(): CccState {
    return {
      workspaceId: this.workspaceId,
      config: this.config,
      rows: this.config.rows.map((row) => {
        const base = {
          rowId: row.rowId,
          name: "",
          recording: "unknown" as const,
          lastResult: this.results.get(row.rowId) ?? null,
        };
        if (cccTargetKey(row) === null || row.cameraNumber === null)
          return {
            ...base,
            connection: "incomplete" as const,
            message: "Enter an RCP IP and camera number",
          };
        const session = this.entries.get(row.rcpIp)?.session;
        const snapshot = session?.snapshot();
        if (!session || snapshot?.phase !== "ready")
          return {
            ...base,
            connection:
              snapshot?.phase === "checking"
                ? ("connecting" as const)
                : ("offline" as const),
            message: snapshot?.lastError ?? "Connecting to RCP",
          };
        const cameras = session
          .cameraObservations()
          .filter((camera) => camera.number === row.cameraNumber);
        const camera = cameras[0];
        if (cameras.length !== 1 || !camera)
          return {
            ...base,
            connection: "error" as const,
            message: cameras.length
              ? "Camera number is ambiguous on this RCP"
              : "Camera number was not found on this RCP",
          };
        const trustworthy = this.recording.usableObservation(
          `${row.rcpIp}/${camera.address}`,
          session.captureCamera(row.cameraNumber),
          camera,
        );
        return {
          ...base,
          name: camera.name,
          connection:
            camera.online === true ? ("online" as const) : ("offline" as const),
          recording:
            camera.online !== true || camera.recording === null || !trustworthy
              ? ("unknown" as const)
              : camera.recording
                ? ("recording" as const)
                : ("stopped" as const),
          message: !trustworthy
            ? "Waiting for fresh camera state"
            : camera.recordingLocked
              ? "Recording locked"
              : camera.online === true
                ? "Online"
                : "Camera offline",
        };
      }),
    };
  }

  mutate(request: CccMutationRequest): Promise<CccState> {
    return this.serialize(async () => {
      this.requireWorkspace(request.workspaceId);
      this.adopt(await this.store.mutate(request));
      return this.state();
    });
  }

  async command(
    request: CccCommandRequest,
    signal?: AbortSignal,
  ): Promise<CccBatchResult & { moduleResult: ModuleActionResult }> {
    const accepted = await this.serialize(async () => {
      this.requireWorkspace(request.workspaceId);
      if (!this.connectorEnabled)
        throw new Error("The CCC connector is missing or disabled");
      const batchId = randomUUID();
      if (
        cccCommandNeedsCamera(request.command) ||
        request.command === "enable-all-cameras" ||
        request.command === "single-switch"
      ) {
        const enableAll = !this.config.rows
          .filter((row) => cccTargetKey(row) !== null)
          .every((row) => row.enabled);
        const mutation =
          request.command === "single-switch"
            ? { kind: "single-switch" as const, enabled: "toggle" as const }
            : request.command === "enable-all-cameras"
              ? {
                  kind: "replace" as const,
                  expectedRevision: this.config.revision,
                  rows: this.config.rows.map((row) =>
                    cccTargetKey(row) === null
                      ? row
                      : { ...row, enabled: enableAll },
                  ),
                  ...(enableAll && this.config.singleSwitch
                    ? { singleSwitch: false }
                    : {}),
                }
              : {
                  kind: "enabled" as const,
                  rowId: request.rowId ?? "",
                  enabled: "toggle" as const,
                };
        this.adopt(
          await this.store.mutate({
            workspaceId: request.workspaceId,
            mutation,
          }),
        );
        return {
          completion: Promise.resolve({
            batchId,
            command: request.command,
            results: [],
            moduleResult: { outcome: "success" as const, targets: [] },
          }),
        };
      }
      const targets = this.enabledTargets();
      if (!targets.length)
        throw new Error("No complete, valid CCC cameras are enabled");
      return {
        completion: this.publishBatch(request, batchId, targets, signal),
      };
    });
    return accepted.completion;
  }

  /** Capture the shared selection and concrete MQTT addresses at acceptance time. */
  private enabledTargets(): readonly CapturedTarget[] {
    return this.config.rows
      .filter((row) => row.enabled && cccTargetKey(row) !== null)
      .map((row) => {
        const epoch = this.epochs.get(row.rowId) ?? 0;
        try {
          const entry = this.entries.get(row.rcpIp);
          if (!entry || entry.retiring || row.cameraNumber === null)
            throw new Error("RCP is unavailable");
          const target = entry.session.captureCamera(row.cameraNumber);
          entry.leases += 1;
          return { row, epoch, entry, target };
        } catch (error) {
          return {
            row,
            epoch,
            error:
              error instanceof Error ? error.message : "Camera is unavailable",
          };
        }
      });
  }

  private async publishBatch(
    request: CccCommandRequest,
    batchId: string,
    targets: readonly CapturedTarget[],
    signal?: AbortSignal,
  ): Promise<CccBatchResult & { moduleResult: ModuleActionResult }> {
    const richResults: RecordingResult[] = [];
    const results = await Promise.all(
      targets.map(async (captured, index): Promise<CccResult> => {
        const { row, entry, target, epoch } = captured;
        let moduleResult: RecordingResult | undefined;
        let phase: CccResult["phase"] = "error";
        let message = captured.error ?? "Camera is unavailable";
        try {
          if (this.stopped || signal?.aborted)
            throw new Error("CCC command was cancelled");
          if (!entry || !target) throw new Error(message);
          const step = PARAMETER_STEPS.get(request.command);
          if (
            step ||
            request.command === "save-white-balance-preset-enabled-cameras"
          ) {
            await this.recording.deliver(
              () =>
                step
                  ? entry.session.stepCameraParameter(target, step, signal)
                  : entry.session.saveWhiteBalancePreset(target, signal),
              signal,
            );
            phase = "sent";
            message = step ? "Sent to RCP" : "Preset save sent to RCP";
            moduleResult = {
              target: row.rowId,
              outcome: "success",
              evidence: "delivered",
              message,
            };
          } else if (cccCommandControlsRecording(request.command)) {
            const result = await this.recording.record(
              {
                key: `${row.rcpIp}/${target.address}`,
                session: entry.session,
                target,
              },
              request.command === "roll-enabled-cameras"
                ? "start"
                : request.command === "stop-enabled-cameras"
                  ? "stop"
                  : "toggle",
              signal,
            );
            phase =
              result.evidence === "confirmed" || result.evidence === "noop"
                ? "confirmed"
                : result.evidence === "unconfirmed"
                  ? "unconfirmed"
                  : "error";
            message = result.message;
            moduleResult = { ...result, target: row.rowId };
          } else {
            throw new Error("Unsupported CCC camera command");
          }
        } catch (error) {
          message = error instanceof Error ? error.message : "Command failed";
        } finally {
          if (entry) this.release(entry);
        }
        const final = {
          rowId: row.rowId,
          rcpIp: row.rcpIp,
          cameraNumber: row.cameraNumber,
          phase,
          message: message.slice(0, 512),
        };
        richResults[index] = moduleResult ?? {
          target: row.rowId,
          outcome: "failure",
          evidence: "error",
          message,
        };
        this.updateResult(request.workspaceId, row, epoch, final);
        return final;
      }),
    );
    return {
      batchId,
      command: request.command,
      results,
      moduleResult: {
        outcome: richResults.every(({ outcome }) => outcome === "success")
          ? "success"
          : "failure",
        targets: richResults,
      },
    };
  }

  configureConsumers(
    definitions: readonly CyanViewRcpConnectionDefinition[],
    connectorEnabled: boolean,
  ): void {
    this.consumers.clear();
    for (const definition of definitions)
      if (definition.enabled)
        this.consumers.set(definition.connectionId, {
          ...definition,
          host: normalizeCccIp(definition.host),
        });
    this.connectorEnabled = connectorEnabled;
    this.adopt(this.config);
  }

  async cameraCommand(
    connectionId: string,
    command:
      | "record-camera"
      | "record-group-all"
      | "start-enabled-cameras"
      | "stop-enabled-cameras",
    cameraNumber?: number,
    signal?: AbortSignal,
  ): Promise<ModuleActionResult> {
    const accepted = await this.serialize(() => {
      const connection = this.consumers.get(connectionId);
      if (!connection)
        throw new Error("CyanView RCP connection is unavailable");
      const enabledOnly =
        command === "start-enabled-cameras" ||
        command === "stop-enabled-cameras";
      if (enabledOnly && !this.connectorEnabled)
        throw new Error("The CCC connector is missing or disabled");
      const entry = this.entries.get(connection.host);
      if (
        !entry ||
        entry.retiring ||
        entry.session.definition.port !== connection.port
      )
        throw new Error("CyanView RCP connection is unavailable or changing");
      const numbers = enabledOnly
        ? this.config.rows
            .filter(
              (row) =>
                row.enabled &&
                row.rcpIp === connection.host &&
                row.cameraNumber !== null,
            )
            .flatMap((row) =>
              row.cameraNumber === null ? [] : [row.cameraNumber],
            )
        : command === "record-camera"
          ? [cameraNumber]
          : [];
      const captures: {
        target?: CyanViewCameraTarget;
        error?: string;
        key: string;
      }[] =
        command === "record-group-all"
          ? entry.session
              .captureGroupAll()
              .map((target) => ({
                target,
                key: `${connection.host}/${target.address}`,
              }))
          : numbers.map((number) => {
              try {
                if (number === undefined)
                  throw new Error("Choose a camera number");
                const target = entry.session.captureCamera(number);
                return { target, key: `${connection.host}/${target.address}` };
              } catch (error) {
                return {
                  key: `${connection.host}/${String(number)}`,
                  error:
                    error instanceof Error
                      ? error.message
                      : "Camera is unavailable",
                };
              }
            });
      if (!captures.length)
        throw new Error(
          enabledOnly
            ? "No complete enabled CCC cameras match this RCP"
            : "The RCP group has no discoverable members",
        );
      entry.leases += captures.length;
      const completion = Promise.all(
        captures.map(async (captured): Promise<RecordingResult> => {
          try {
            if (!captured.target)
              return {
                target: captured.key,
                outcome: "failure",
                evidence: "error",
                message: captured.error ?? "Camera is unavailable",
              };
            return await this.recording.record(
              {
                key: captured.key,
                session: entry.session,
                target: captured.target,
              },
              command === "start-enabled-cameras"
                ? "start"
                : command === "stop-enabled-cameras"
                  ? "stop"
                  : "toggle",
              signal,
            );
          } finally {
            this.release(entry);
          }
        }),
      );
      return { completion };
    });
    const targets = await accepted.completion;
    return {
      outcome: targets.every((target) => target.outcome === "success")
        ? "success"
        : "failure",
      targets,
    };
  }

  /** Feedback decisions are module-owned; the host only applies the chosen presentation colors. */
  feedback(): Record<string, boolean | null> {
    const result: Record<string, boolean | null> = {};
    const enabled = this.config.rows.filter(
      (row) => row.enabled && cccTargetKey(row) !== null,
    );
    const live = this.state().rows.filter((row) =>
      enabled.some((saved) => saved.rowId === row.rowId),
    );
    for (const row of this.config.rows)
      for (const command of [
        "enable-camera",
        "disable-camera",
        "toggle-camera-enabled",
      ])
        result[`${command}/${row.rowId}`] = this.connectorEnabled
          ? row.enabled
          : null;
    const complete = this.config.rows.filter(
      (row) => cccTargetKey(row) !== null,
    );
    result["enable-all-cameras/"] =
      complete.length > 0 && complete.every((row) => row.enabled);
    result["single-switch/"] = Boolean(this.config.singleSwitch);
    const ready =
      live.length > 0 &&
      live.every(
        (row) => row.connection === "online" && row.recording !== "unknown",
      );
    result["roll-enabled-cameras/"] = ready
      ? live.every((row) => row.recording === "recording")
      : null;
    result["stop-enabled-cameras/"] = ready
      ? live.every((row) => row.recording === "stopped")
      : null;
    result["roll-toggle-enabled-cameras/"] = ready
      ? live.every((row) => row.recording === "recording")
      : null;
    if (!this.connectorEnabled)
      for (const key of Object.keys(result)) result[key] = null;
    return result;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const entry of this.entries.values()) entry.session.stop();
    this.entries.clear();
    await this.recording.dispose();
    this.results.clear();
    this.emit();
  }

  private adopt(config: CccConfig): void {
    const previous = new Map(
      this.config.rows.map((row) => [row.rowId, cccTargetKey(row)]),
    );
    for (const row of config.rows) {
      if (
        previous.get(row.rowId) !== cccTargetKey(row) ||
        !this.epochs.has(row.rowId)
      ) {
        this.results.delete(row.rowId);
        this.epochs.set(row.rowId, ++this.nextEpoch);
      }
    }
    for (const id of this.epochs.keys())
      if (!config.rows.some((row) => row.rowId === id)) this.epochs.delete(id);
    for (const id of this.results.keys())
      if (!config.rows.some((row) => row.rowId === id)) this.results.delete(id);
    this.config = config;
    const hosts = new Set([
      ...(this.connectorEnabled ? config.rows.map((row) => row.rcpIp) : []),
      ...[...this.consumers.values()].map((connection) => connection.host),
    ]);
    for (const host of hosts) {
      if (!host) continue;
      const matching = [...this.consumers.values()].filter(
        (connection) => connection.host === host,
      );
      const ports = new Set(matching.map((connection) => connection.port));
      if (ports.size > 1) {
        const prior = this.entries.get(host);
        if (prior) prior.retiring = true;
        if (prior && prior.leases === 0) {
          this.entries.delete(host);
          prior.session.stop();
        }
        continue;
      }
      const definition =
        matching[0] ??
        CyanViewRcpConnectionDefinitionSchema.parse({
          type: "cyanview-rcp",
          connectionId: randomUUID(),
          name: `CCC ${host}`,
          host,
          port: 1883,
          requestTimeoutMs: 3000,
          enabled: true,
          schemaVersion: 1,
        });
      const prior = this.entries.get(host);
      const transport = `${String(definition.port)}/${String(definition.requestTimeoutMs)}`;
      if (prior?.transport === transport) {
        prior.retiring = false;
        continue;
      }
      if (prior) {
        if (prior.leases) {
          prior.retiring = true;
          continue;
        }
        this.entries.delete(host);
        prior.session.stop();
      }
      this.entries.set(host, {
        transport,
        retiring: false,
        session: this.createSession(definition, () => {
          this.recording.notify();
          this.emit();
        }),
        leases: 0,
      });
    }
    this.pruneConnections();
    this.emit();
  }

  private release(entry: ConnectionEntry): void {
    entry.leases -= 1;
    this.pruneConnections();
    if (entry.leases === 0 && entry.retiring) this.adopt(this.config);
  }

  private pruneConnections(): void {
    const used = new Set([
      ...(this.connectorEnabled
        ? this.config.rows.map((row) => row.rcpIp)
        : []),
      ...[...this.consumers.values()].map((connection) => connection.host),
    ]);
    for (const [ip, entry] of this.entries)
      if (!used.has(ip) && entry.leases === 0) {
        this.entries.delete(ip);
        entry.session.stop();
      }
  }
  private updateResult(
    workspaceId: string,
    row: CccRow,
    epoch: number,
    result: CccResult,
  ): void {
    if (
      workspaceId !== this.workspaceId ||
      this.epochs.get(row.rowId) !== epoch ||
      !this.config.rows.some(
        (current) =>
          current.rowId === row.rowId &&
          cccTargetKey(current) === cccTargetKey(row),
      )
    )
      return;
    this.results.set(row.rowId, result);
    this.emit();
  }
  private requireWorkspace(workspaceId: string): void {
    if (this.stopped || workspaceId !== this.workspaceId)
      throw new Error("CCC workspace is unavailable");
  }
  private serialize<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.acceptance.then(operation, operation);
    this.acceptance = result.catch(() => undefined);
    return result;
  }
  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* An observer cannot interrupt control. */
      }
    }
  }
}

export type CccControllerContract = Pick<
  CccController,
  "activate" | "state" | "mutate" | "command" | "subscribe" | "stop"
>;
