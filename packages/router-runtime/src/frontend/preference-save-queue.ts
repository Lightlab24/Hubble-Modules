/**
 * Shows a preference at once and saves choices in order. A failed save rolls
 * back to the last saved value unless a newer choice is already waiting.
 */
export class PreferenceSaveQueue<T> {
  private saved: T;
  private shown: T;
  private version = 0;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    initial: T,
    private readonly save: (value: T) => Promise<unknown>,
    private readonly changed: (value: T) => void,
    private readonly failed: (message: string) => void,
  ) {
    this.saved = initial;
    this.shown = initial;
  }

  get value(): T {
    return this.shown;
  }

  set(next: T): Promise<void> {
    const version = ++this.version;
    this.shown = next;
    this.changed(next);
    this.tail = this.tail
      .then(() => this.save(next))
      .then(
        () => {
          this.saved = next;
        },
        (error: unknown) => {
          if (version === this.version) {
            this.shown = this.saved;
            this.changed(this.saved);
          }
          this.failed(error instanceof Error ? error.message : String(error));
        },
      );
    return this.tail;
  }
}
