import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ModuleJsonValue } from "@hubble/module-sdk";

/** Device uncertainty is local runtime state, never portable workspace configuration. */
export function recordingCheckpoint(directory: string) {
  const file = path.join(directory, "recording.json");
  let recovery: "initial" | "clean" | "unclean" = "initial";
  let checkpoint: ModuleJsonValue = null;
  try {
    const saved = JSON.parse(readFileSync(file, "utf8")) as {
      clean?: unknown;
      checkpoint?: ModuleJsonValue;
    };
    recovery = saved.clean === true ? "clean" : "unclean";
    checkpoint = saved.checkpoint ?? null;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      recovery = "unclean";
  }
  return {
    recovery,
    checkpoint,
    write(checkpoint: ModuleJsonValue, clean = false) {
      mkdirSync(directory, { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify({ clean, checkpoint }), {
        mode: 0o600,
        flush: true,
      });
      renameSync(temporary, file);
    },
  };
}
