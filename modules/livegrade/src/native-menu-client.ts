import {
  NativeMenuResponseSchema,
  type ModuleHostServices,
  type NativeMenuRequest,
  type NativeMenuResponse,
} from "@hubble/module-sdk";
import type {
  LiveGradeApplicationEdition,
  LiveGradeSlotCatalogEntry,
} from "./config.js";
import {
  LiveGradeHelperClientError,
  LiveGradeHelperResponseSchema,
  type LiveGradeHelperClientContract,
  type LiveGradeHelperResponse,
} from "./livegrade-helper-client.js";

/** Application identity and menu semantics are package data, never host enums. */
export function liveGradeNativeProfile(target: {
  generation: 6 | 7;
  edition: LiveGradeApplicationEdition;
}) {
  if (
    (target.generation === 6 && target.edition === "frontier") ||
    (target.generation === 7 && target.edition === "pro")
  )
    throw new Error("Unsupported LiveGrade edition");
  return {
    target:
      target.generation === 6
        ? {
            bundleId:
              target.edition === "pro"
                ? "com.pomfort.LiveGrade6"
                : "com.pomfort.LiveGradeStudio6",
          }
        : {
            bundleId: "com.pomfort.Livegrade7",
            executableName:
              target.edition === "frontier"
                ? "Livegrade Frontier"
                : "Livegrade",
          },
    path: (target.generation === 6
      ? ["Slots", "Switch to Slot"]
      : ["Slots", "Switch to", "Switch to Input Slot"]
    ).map((title) => ({ title })),
  };
}
type Item = NativeMenuResponse["items"][number];
type Catalog = {
  response: LiveGradeHelperResponse;
  items: ReadonlyMap<number, Item>;
  processId?: number;
};

export function createLiveGradeNativeClient(
  services: ModuleHostServices | undefined,
  target: { generation: 6 | 7; edition: LiveGradeApplicationEdition },
): LiveGradeHelperClientContract {
  const profile = liveGradeNativeProfile(target);
  async function request(input: NativeMenuRequest, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!services)
      throw new LiveGradeHelperClientError(
        "helper_launch_failed",
        "Native menu service is unavailable",
      );
    const result = NativeMenuResponseSchema.parse(
      await services.request("native-menus", 1, input, signal),
    );
    signal.throwIfAborted();
    return result;
  }
  async function bounded<T>(
    timeoutMs: number,
    signal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      return await operation(combined);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (timeout.aborted)
        throw new LiveGradeHelperClientError(
          "helper_timeout",
          "LiveGrade native menu request timed out; dispatched commands are not replayed",
        );
      throw error;
    }
  }
  async function read(signal: AbortSignal): Promise<Catalog> {
    const items = new Map<number, Item>(),
      slots: LiveGradeSlotCatalogEntry[] = [],
      cursors = new Set<string>();
    let cursor: string | undefined,
      application: NativeMenuResponse["application"] = null;
    for (let page = 0; page < 16; page++) {
      const native = await request(
        { method: "read", ...profile, ...(cursor ? { cursor } : {}) },
        signal,
      );
      const failure = nativeFailure(native);
      if (failure) return { response: failure, items: new Map() };
      if (
        !native.application ||
        (application &&
          JSON.stringify(application) !== JSON.stringify(native.application))
      )
        throw new LiveGradeHelperClientError(
          "helper_invalid_response",
          "LiveGrade application changed during menu discovery",
        );
      application = native.application;
      for (const item of native.items) {
        // Slot positions match the legacy enabled direct-child catalog; other commands
        // in nested menus must never become slots or change numeric assignments.
        if (
          !item.enabled ||
          item.path.length !== profile.path.length + 1 ||
          !profile.path.every((part, i) => item.path[i]?.title === part.title)
        )
          continue;
        const menuTitle = item.path
          .at(-1)!
          .title.split("\t")
          .map((part) => part.trim())
          .filter(Boolean)
          .join(" ");
        if (!menuTitle || menuTitle.length > 256) continue;
        if (target.generation === 6 && !/^[A-Z]$/u.test(menuTitle)) continue;
        const position =
          target.generation === 6
            ? menuTitle.charCodeAt(0) - 64
            : slots.length + 1;
        if (items.has(position))
          return {
            response: failed(
              "livegrade_slot_ambiguous",
              "Multiple menu commands identify the same slot",
            ),
            items: new Map(),
          };
        if (position > 4096)
          return {
            response: failed(
              "livegrade_slots_unavailable",
              "LiveGrade exposes too many slots",
            ),
            items: new Map(),
          };
        items.set(position, item);
        slots.push({ position, menuTitle });
      }
      if (native.nextCursor === null) {
        if (!slots.length)
          return {
            response: failed(
              "livegrade_slots_unavailable",
              "No enabled LiveGrade slots are available",
            ),
            items,
          };
        return {
          response: LiveGradeHelperResponseSchema.parse({
            protocolVersion: 1,
            phase: "ready",
            applicationVersion: application.version,
            slots: slots.sort((a, b) => a.position - b.position),
            selected: null,
            focusViolation: false,
            errorCode: null,
            message: null,
          }),
          items,
          processId: application.pid,
        };
      }
      if (cursors.has(native.nextCursor))
        throw new LiveGradeHelperClientError(
          "helper_invalid_response",
          "Native menu discovery repeated a cursor",
        );
      cursors.add(native.nextCursor);
      cursor = native.nextCursor;
    }
    return {
      response: failed(
        "livegrade_slots_unavailable",
        "LiveGrade slot discovery exceeded its page limit",
      ),
      items: new Map(),
    };
  }
  const probe = (timeout: number) =>
    bounded(
      timeout,
      undefined,
      async (signal) => (await read(signal)).response,
    );
  return {
    probe,
    // Permission prompts remain an operator action in the native app. This legacy
    // method only rechecks the current grant; background workers never prompt.
    requestAccessibilityPermission: probe,
    selectSlot(input) {
      return bounded(input.timeoutMs, input.signal, async (signal) => {
        const catalog = await read(signal);
        if (catalog.response.phase !== "ready") return catalog.response;
        const slot = catalog.response.slots.find(
          (item) => item.position === input.position,
        );
        const item = catalog.items.get(input.position);
        if (
          !slot ||
          !item ||
          (input.expectedTitle !== undefined &&
            input.expectedTitle !== slot.menuTitle)
        )
          return failed(
            "livegrade_slot_mismatch",
            "LiveGrade slots changed; refresh and select the intended slot again",
          );
        const native = await request(
          {
            method: "select",
            target: profile.target,
            path: item.path,
            preserveBackgroundFocus: true,
            expectedProcessId: catalog.processId!,
          },
          signal,
        );
        const failure = nativeFailure(native);
        if (failure) return failure;
        if (!native.completed)
          return failed(
            "livegrade_protocol_error",
            "The native menu command did not complete",
          );
        // selected records which command completed. It is response evidence, not
        // a claim that LiveGrade independently reported a selected/checked state.
        return { ...catalog.response, selected: slot };
      });
    },
  };
}
function failed(
  code: string,
  message: string,
  phase: LiveGradeHelperResponse["phase"] = "menu-unavailable",
  version: string | null = null,
): LiveGradeHelperResponse {
  return LiveGradeHelperResponseSchema.parse({
    protocolVersion: 1,
    phase,
    applicationVersion: version,
    slots: [],
    selected: null,
    focusViolation: code === "livegrade_focus_violation",
    errorCode: code,
    message,
  });
}
function nativeFailure(
  native: NativeMenuResponse,
): LiveGradeHelperResponse | null {
  const version = native.application?.version ?? null;
  if (!native.available)
    return failed(
      "livegrade_unconfigured",
      "Native menu service is unavailable",
      "error",
      version,
    );
  if (native.errorCode === "native_application_not_running")
    return failed(
      "livegrade_not_running",
      "The selected LiveGrade application is not running",
      "not-running",
    );
  if (native.errorCode === "native_application_ambiguous")
    return failed(
      "livegrade_application_ambiguous",
      "More than one matching LiveGrade process is running",
      "error",
    );
  if (native.errorCode === "native_application_changed")
    return failed(
      "livegrade_slot_mismatch",
      "LiveGrade restarted; refresh its slots before selecting",
      "error",
      version,
    );
  if (!native.permissionGranted)
    return failed(
      "accessibility_permission_required",
      "Enable Hubble Accessibility access in macOS System Settings",
      "permission-required",
      version,
    );
  if (native.focusViolation)
    return failed(
      "livegrade_focus_violation",
      "LiveGrade became frontmost during background slot control",
      "error",
      version,
    );
  if (native.errorCode || native.truncated)
    return failed(
      "livegrade_menu_unavailable",
      "The selected LiveGrade menu is unavailable, ambiguous or incomplete",
      "menu-unavailable",
      version,
    );
  return null;
}
