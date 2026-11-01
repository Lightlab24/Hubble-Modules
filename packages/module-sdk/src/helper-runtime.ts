import {
  ModuleHelperInputSchema,
  ModuleHelperOutputSchema,
  type ModuleHelperValueSchema,
} from "./helpers.js";
import type { z } from "zod";

type Json = z.infer<typeof ModuleHelperValueSchema>;
/** Call after module-owned initialization; native implementations can use the same public wire protocol. */
export function serveModuleHelper(options: {
  methods: Record<
    string,
    (value: Json, signal: AbortSignal) => Json | Promise<Json>
  >;
  dispose?: () => void | Promise<void>;
}) {
  const pending = new Map<string, AbortController>();
  let buffer = Buffer.alloc(0),
    closing = false;
  const send = (value: z.infer<typeof ModuleHelperOutputSchema>) => {
    if (!closing)
      process.stdout.write(
        JSON.stringify(ModuleHelperOutputSchema.parse(value)) + "\n",
      );
  };
  const close = async (code = 0) => {
    if (closing) return;
    closing = true;
    for (const controller of pending.values()) controller.abort();
    try {
      await options.dispose?.();
    } finally {
      process.exit(code);
    }
  };
  process.stdin.on("data", (data: Buffer) => {
    buffer = Buffer.concat([buffer, data]);
    if (buffer.byteLength > 1048576) {
      void close(1);
      return;
    }
    let boundary: number;
    while ((boundary = buffer.indexOf(10)) !== -1) {
      const line = buffer.subarray(0, boundary);
      buffer = buffer.subarray(boundary + 1);
      try {
        if (line.byteLength > 786432)
          throw new Error("Helper message too large");
        const input = ModuleHelperInputSchema.parse(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)),
        );
        if (input.type === "cancel") {
          pending.get(input.id)?.abort();
          continue;
        }
        if (pending.has(input.id) || pending.size >= 16)
          throw new Error("Invalid helper request identity or capacity");
        const method = Object.hasOwn(options.methods, input.methodId)
          ? options.methods[input.methodId]
          : undefined;
        if (!method) {
          send({
            type: "error",
            id: input.id,
            message: "Unknown helper method",
          });
          continue;
        }
        const controller = new AbortController();
        pending.set(input.id, controller);
        void Promise.resolve()
          .then(() => method(input.value, controller.signal))
          .then((value) => {
            if (controller.signal.aborted)
              send({ type: "cancelled", id: input.id });
            else send({ type: "result", id: input.id, value });
          })
          .catch((error: unknown) => {
            if (controller.signal.aborted)
              send({ type: "cancelled", id: input.id });
            else
              send({
                type: "error",
                id: input.id,
                message: (error instanceof Error
                  ? error.message
                  : "Helper command failed"
                ).slice(0, 1000),
              });
          })
          .finally(() => pending.delete(input.id));
      } catch {
        void close(1);
        return;
      }
    }
  });
  process.stdin.on("end", () => {
    void close();
  });
  process.on("SIGTERM", () => {
    void close();
  });
  process.on("SIGINT", () => {
    void close();
  });
  send({ type: "ready", protocolVersion: 1 });
}
