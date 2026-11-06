export interface LatestValueQueueOptions<T> {
  send(value: T): Promise<unknown>;
  /** `newest` is false when another value was queued while this one was in flight. */
  onSettled(result: { value: T; error: Error | null; newest: boolean }): void;
}
export interface LatestValueQueue<T> {
  push(value: T): void;
  /** True while a command is in flight or waiting to be sent. */
  readonly pending: boolean;
}

/** Keeps one command in flight. Values arriving meanwhile collapse to the newest. */
export function createLatestValueQueue<T>(
  options: LatestValueQueueOptions<T>,
): LatestValueQueue<T> {
  let inFlight = false;
  let waiting: { value: T } | null = null;
  const pump = () => {
    if (inFlight || !waiting) return;
    const { value } = waiting;
    waiting = null;
    inFlight = true;
    const settle = (error: Error | null) => {
      inFlight = false;
      options.onSettled({ value, error, newest: waiting === null });
      pump();
    };
    options.send(value).then(
      () => {
        settle(null);
      },
      (error: unknown) => {
        settle(error instanceof Error ? error : new Error(String(error)));
      },
    );
  };
  return {
    push(value) {
      waiting = { value };
      pump();
    },
    get pending() {
      return inFlight || waiting !== null;
    },
  };
}
