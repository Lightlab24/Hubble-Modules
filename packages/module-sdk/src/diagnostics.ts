import { z } from "zod";

export const ModuleFailureCategorySchema = z.enum([
  "action-rejected",
  "configuration",
  "disconnected",
  "process-crash",
  "unresponsive",
  "lifecycle",
  "unknown",
]);
export type ModuleFailureCategory = z.infer<typeof ModuleFailureCategorySchema>;

/** Bounded at the child boundary and redacted again by the owning supervisor. */
export const DiagnosticErrorSchema = z.object({
  name: z.string().max(128),
  message: z.string().max(2000),
  code: z.string().max(128).optional(),
  stack: z.string().max(8000).optional(),
  cause: z.string().max(2000).optional(),
});
export type DiagnosticError = z.infer<typeof DiagnosticErrorSchema>;

export const ModuleRecoverySchema = z.strictObject({
  incidentId: z.uuid(),
  phase: z.enum(["waiting", "restarting", "exhausted", "recovered"]),
  attempt: z.int().min(0).max(3),
  nextAttemptAt: z.iso.datetime().nullable(),
});
export type ModuleRecovery = z.infer<typeof ModuleRecoverySchema>;

export function describeDiagnosticError(error: unknown): DiagnosticError {
  try {
    if (!(error instanceof Error))
      return { name: "Error", message: String(error).slice(0, 2000) };
    return {
      name: error.name.slice(0, 128),
      message: error.message.slice(0, 2000),
      ...(typeof error.stack === "string"
        ? { stack: error.stack.slice(0, 8000) }
        : {}),
      ...("code" in error && typeof error.code === "string"
        ? { code: error.code.slice(0, 128) }
        : {}),
      ...(error.cause === undefined
        ? {}
        : {
            cause: (error.cause instanceof Error
              ? error.cause.toString()
              : typeof error.cause === "string"
                ? error.cause
                : JSON.stringify(error.cause)
            ).slice(0, 2000),
          }),
    };
  } catch {
    return { name: "Error", message: "Error details unavailable" };
  }
}

export function redactDiagnostic(
  value: string,
  secrets: readonly string[] = [],
): string {
  for (const secret of secrets)
    if (secret) {
      value = value.split(secret).join("[redacted]");
      const escaped = JSON.stringify(secret).slice(1, -1);
      if (escaped !== secret) value = value.split(escaped).join("[redacted]");
    }
  return value
    .replace(
      /("(?:authorization|proxy-authorization|password|passwd|(?:access[_-]|refresh[_-]|id[_-])?token|api[_-]?key|secret)"\s*:\s*")(?:\\.|[^"\\])*"/giu,
      '$1[redacted]"',
    )
    .replace(
      /(\b(?:authorization|proxy-authorization)["']?\s*[:=]\s*["']?)(?:Bearer|Basic)?\s*[^\r\n",;]+/giu,
      "$1[redacted]",
    )
    .replace(
      /(\b(?:password|passwd|(?:access[_-]|refresh[_-]|id[_-])?token|api[_-]?key|secret)["']?\s*[=:]\s*["']?)[^\s"'&,;}]+/giu,
      "$1[redacted]",
    )
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/giu, "$1[redacted]@")
    .replace(
      /(?:\/Users\/|\/Volumes\/|\/mnt\/|\/media\/|\/home\/|\/private\/|\/tmp\/|\/var\/)[^\s)"']+/gu,
      "[private path]",
    )
    .replace(/[A-Z]:\\[^\r\n)"']+/giu, "[private path]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "");
}

export interface ModuleProcessFailure {
  readonly kind:
    | "process-exit"
    | "process-error"
    | "timeout"
    | "transport"
    | "protocol";
  readonly message: string;
  readonly operation?: string;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly error?: DiagnosticError;
  readonly console?: string;
}
