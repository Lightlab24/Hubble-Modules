import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import type {
  ModuleFeedback,
  ModuleFeedbackSubscription,
} from "@hubble/module-sdk";
import { createRouterFeedbackPublisher } from "../src/feedback-publisher.js";

const publishers: ReturnType<typeof createRouterFeedbackPublisher>[] = [];
afterEach(() => {
  for (const publisher of publishers.splice(0)) publisher.close();
});
function fixture(count = 70) {
  let active = -1;
  const subscriptions = Array.from({ length: count }, (_, row) => ({
    id: "matrix",
    fields: { actionId: String(row) },
  }));
  const publish = vi.fn<(feedback: ModuleFeedback) => void>();
  const publisher = createRouterFeedbackPublisher(
    (items) =>
      items.map((item) => ({
        ...item,
        state: Number(item.fields.actionId) === active ? "active" : "inactive",
        observedAt: new Date().toISOString(),
        appearance: {
          backgroundColor:
            Number(item.fields.actionId) === active ? "#09ECFF" : null,
        },
      })),
    publish,
  );
  publishers.push(publisher);
  return {
    publisher,
    publish,
    subscriptions,
    setActive(value: number) {
      active = value;
      publisher.invalidate();
    },
  };
}
async function drain() {
  for (let turn = 0; turn < 24; turn++) await nextTurn();
}

it("keeps a 512-row initial subscription below the worker IPC burst limit", async () => {
  const h = fixture(512);
  h.publisher.subscribe(h.subscriptions);
  await nextTurn();
  expect(h.publish.mock.calls.length).toBeLessThanOrEqual(32);
  await drain();
  expect(h.publish).toHaveBeenCalledTimes(512);
  expect(
    new Set(h.publish.mock.calls.map(([value]) => value.fields?.actionId)).size,
  ).toBe(512);
});

it("does not resend 70 unchanged rows on every routing notification or resubscription", async () => {
  const h = fixture();
  h.publisher.subscribe(h.subscriptions);
  await drain();
  h.publish.mockClear();
  for (let index = 0; index < 17; index++) {
    h.publisher.subscribe(structuredClone(h.subscriptions));
    h.publisher.invalidate();
    await nextTurn();
  }
  await drain();
  expect(h.publish.mock.calls.length).toBe(0);
  h.setActive(3);
  await drain();
  expect(
    h.publish.mock.calls.map(([value]) => [
      value.fields?.actionId,
      value.state,
    ]),
  ).toEqual([["3", "active"]]);
  h.setActive(4);
  await drain();
  expect(
    h.publish.mock.calls
      .slice(1)
      .map(([value]) => [value.fields?.actionId, value.state]),
  ).toEqual([
    ["3", "inactive"],
    ["4", "active"],
  ]);
});

it("retains the latest observation and cancels removed rows and disposed work", async () => {
  const h = fixture(512);
  h.publisher.subscribe(h.subscriptions);
  await Promise.resolve();
  h.setActive(511);
  h.publisher.subscribe([h.subscriptions[511]!]);
  await drain();
  expect(
    h.publish.mock.calls.map(([value]) => [
      value.fields?.actionId,
      value.state,
    ]),
  ).toEqual([["511", "active"]]);
  h.setActive(-1);
  h.publisher.close();
  await drain();
  expect(h.publish).toHaveBeenCalledTimes(1);
});

it("republishes removed subscriptions when restored and distinguishes edited fields", async () => {
  const h = fixture(1);
  h.publisher.subscribe(h.subscriptions);
  await drain();
  h.publisher.subscribe([]);
  await drain();
  h.publisher.subscribe(h.subscriptions);
  await drain();
  expect(h.publish).toHaveBeenCalledTimes(2);
  const edited: ModuleFeedbackSubscription = {
    id: "matrix",
    fields: { actionId: "0", contextId: "new-context" },
  };
  h.publisher.subscribe([edited]);
  await drain();
  expect(h.publish).toHaveBeenCalledTimes(3);
  expect(h.publish.mock.calls[2]?.[0].fields).toEqual(edited.fields);
});
