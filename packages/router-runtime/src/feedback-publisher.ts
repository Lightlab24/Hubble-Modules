import {
  moduleFeedbackKey,
  type ModuleFeedback,
  type ModuleFeedbackSubscription,
} from "@hubble/module-sdk";

/** Publish changed row appearances, yielding between bounded IPC batches. */
export function createRouterFeedbackPublisher(
  evaluate: (
    subscriptions: readonly ModuleFeedbackSubscription[],
  ) => readonly ModuleFeedback[],
  publish: (feedback: ModuleFeedback) => void,
) {
  let subscriptions: readonly ModuleFeedbackSubscription[] = [];
  const sent = new Map<string, string>();
  const pending = new Map<
    string,
    { value: ModuleFeedback; signature: string }
  >();
  let queued = false;
  let closed = false;
  let drain: NodeJS.Immediate | undefined;
  const key = (value: Pick<ModuleFeedback, "id" | "fields">) =>
    moduleFeedbackKey(value.id, value.fields);
  const flush = () => {
    drain = undefined;
    if (closed) return;
    let count = 0;
    for (const [id, item] of pending) {
      pending.delete(id);
      publish(item.value);
      sent.set(id, item.signature);
      if (++count === 32) break;
    }
    if (pending.size) drain = setImmediate(flush);
  };
  const invalidate = () => {
    if (closed || queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (closed) return;
      for (const value of evaluate(subscriptions)) {
        const id = key(value);
        // A fresh timestamp alone does not change the observed row state.
        const { observedAt: _observedAt, ...appearance } = value;
        const signature = JSON.stringify(appearance);
        if (sent.get(id) === signature) pending.delete(id);
        else pending.set(id, { value, signature });
      }
      if (pending.size && !drain) drain = setImmediate(flush);
    });
  };
  return {
    invalidate,
    subscribe(next: readonly ModuleFeedbackSubscription[]) {
      subscriptions = next;
      const retained = new Set(next.map(key));
      for (const id of sent.keys()) if (!retained.has(id)) sent.delete(id);
      for (const id of pending.keys())
        if (!retained.has(id)) pending.delete(id);
      invalidate();
    },
    close() {
      closed = true;
      subscriptions = [];
      if (drain) clearImmediate(drain);
      pending.clear();
      sent.clear();
    },
  };
}
