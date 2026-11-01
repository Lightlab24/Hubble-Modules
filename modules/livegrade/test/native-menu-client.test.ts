import { afterEach, expect, it, vi } from "vitest";
import {
  createModuleHostServices,
  NativeMenuResponseSchema,
  type NativeMenuRequest,
} from "@hubble/module-sdk";
import {
  createLiveGradeNativeClient,
  liveGradeNativeProfile,
} from "../src/native-menu-client.js";

afterEach(() => vi.useRealTimers());
const profile = liveGradeNativeProfile({ generation: 7, edition: "frontier" });
function response(titles: string[], extra: Record<string, unknown> = {}) {
  return NativeMenuResponseSchema.parse({
    available: true,
    permissionGranted: true,
    application: { ...profile.target, version: "7.2", pid: 42 },
    items: titles.map((title) => ({
      path: [...profile.path, { title }],
      enabled: true,
    })),
    errorCode: null,
    message: null,
    ...extra,
  });
}
function fixture(
  respond: (input: NativeMenuRequest, signal?: AbortSignal) => unknown = () =>
    response(["[1] A - In 1"]),
) {
  const requests: NativeMenuRequest[] = [];
  const services = createModuleHostServices(async (method, value, signal) => {
    expect(method).toBe("service");
    const call = value as {
      service: string;
      version: number;
      input: NativeMenuRequest;
    };
    expect(call.service).toBe("native-menus");
    expect(call.version).toBe(1);
    requests.push(call.input);
    return JSON.parse(JSON.stringify(await respond(call.input, signal)));
  });
  return {
    requests,
    services,
    client: createLiveGradeNativeClient(services, {
      generation: 7,
      edition: "frontier",
    }),
  };
}

it("owns exact edition profiles and legacy Studio/Pro letter positions", async () => {
  expect(
    liveGradeNativeProfile({ generation: 6, edition: "pro" }).target,
  ).toEqual({ bundleId: "com.pomfort.LiveGrade6" });
  expect(
    liveGradeNativeProfile({ generation: 7, edition: "standard" }).target
      .executableName,
  ).toBe("Livegrade");
  expect(() =>
    liveGradeNativeProfile({ generation: 6, edition: "frontier" }),
  ).toThrow();
  const p = liveGradeNativeProfile({ generation: 6, edition: "standard" });
  const f = fixture(() =>
    response([], {
      application: {
        ...p.target,
        executableName: null,
        version: "6.5",
        pid: 11,
      },
      items: ["C", "other", "A", "B"].map((title, i) => ({
        path: [...p.path, { title }],
        enabled: i !== 3,
      })),
    }),
  );
  const client = createLiveGradeNativeClient(f.services, {
    generation: 6,
    edition: "standard",
  });
  await expect(client.probe(1500)).resolves.toMatchObject({
    slots: [
      { position: 1, menuTitle: "A" },
      { position: 3, menuTitle: "C" },
    ],
  });
  expect(f.requests[0]).toMatchObject({ target: p.target, path: p.path });
});

it("reads all cursor pages, excludes disabled/nested entries and invokes the raw exact path with a process precondition", async () => {
  const cursor = "12345678-1234-1234-1234-123456789abc:1";
  const f = fixture((input) =>
    input.method === "select"
      ? response([], { completed: true })
      : input.cursor
        ? response(["[2]\tB - In 2"])
        : response(["[1] A - In 1"], { nextCursor: cursor }),
  );
  await expect(
    f.client.selectSlot({
      position: 2,
      expectedTitle: "[2] B - In 2",
      timeoutMs: 1500,
    }),
  ).resolves.toMatchObject({
    phase: "ready",
    selected: { position: 2, menuTitle: "[2] B - In 2" },
  });
  expect(f.requests).toHaveLength(3);
  expect(f.requests[2]).toEqual({
    method: "select",
    target: profile.target,
    path: [...profile.path, { title: "[2]\tB - In 2" }],
    preserveBackgroundFocus: true,
    expectedProcessId: 42,
  });
});

it("rejects changed slot identities without selecting a replacement", async () => {
  const f = fixture(() => response(["Renamed input"]));
  await expect(
    f.client.selectSlot({
      position: 1,
      expectedTitle: "Previous input",
      timeoutMs: 1500,
    }),
  ).resolves.toMatchObject({ errorCode: "livegrade_slot_mismatch" });
  expect(f.requests.every((input) => input.method === "read")).toBe(true);
});

it.each([
  ["native_focus_changed", "livegrade_focus_violation"],
  ["native_application_changed", "livegrade_slot_mismatch"],
  ["native_menu_disabled", "livegrade_menu_unavailable"],
] as const)(
  "returns %s as failed evidence and never retries a dispatched command",
  async (native, expected) => {
    const f = fixture((input) =>
      input.method === "select"
        ? response([], {
            errorCode: native,
            message: "Fixture failure",
            focusViolation: native === "native_focus_changed",
          })
        : response(["A"]),
    );
    await expect(
      f.client.selectSlot({ position: 1, timeoutMs: 1500 }),
    ).resolves.toMatchObject({ errorCode: expected, selected: null });
    expect(
      f.requests.filter((input) => input.method === "select"),
    ).toHaveLength(1);
  },
);

it("aborting discovery prevents subsequent native dispatch", async () => {
  let release!: () => void;
  const f = fixture(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return response(["A"]);
  });
  const controller = new AbortController();
  const pending = f.client.selectSlot({
    position: 1,
    timeoutMs: 1500,
    signal: controller.signal,
  });
  const rejected = expect(pending).rejects.toThrow("Cancelled");
  controller.abort(new Error("Cancelled"));
  release();
  await rejected;
  expect(f.requests.map((input) => input.method)).toEqual(["read"]);
});

it("fails incomplete and process-changing catalogs instead of returning partial slots", async () => {
  const f = fixture(() => response(["A"], { truncated: true }));
  await expect(f.client.probe(1500)).resolves.toMatchObject({
    phase: "menu-unavailable",
    slots: [],
  });
  const g = fixture((input) =>
    input.method === "read" && input.cursor
      ? response(["B"], {
          application: { ...profile.target, pid: 99, version: "7.2" },
        })
      : response(["A"], {
          nextCursor: "12345678-1234-1234-1234-123456789abc:1",
        }),
  );
  await expect(g.client.probe(1500)).rejects.toMatchObject({
    code: "helper_invalid_response",
  });
});
