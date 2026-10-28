import type {
  ModuleActionResult,
  ModuleExecutionContext,
} from "@hubble/module-sdk";

export interface RecordingTargetResult {
  readonly target: string;
  readonly outcome: "success" | "failure";
  readonly evidence:
    | "noop"
    | "submitted"
    | "delivered"
    | "confirmed"
    | "unconfirmed"
    | "skipped"
    | "error";
  readonly message: string;
}
export interface RecordingBatchResult {
  readonly outcome: "success" | "failure";
  readonly message?: string;
  readonly targets: readonly RecordingTargetResult[];
}

export function actionResult(
  result: RecordingBatchResult,
  execution: Pick<ModuleExecutionContext, "log">,
): ModuleActionResult {
  for (const target of result.targets)
    execution.log({
      level: target.outcome === "failure" ? "error" : "info",
      stage: "camera-result",
      message: `${target.target}: ${target.message}`.slice(0, 1000),
    });
  if (result.outcome === "failure")
    return {
      status: "failure",
      category: result.targets.some(
        (target) => target.evidence === "unconfirmed",
      )
        ? "timeout"
        : "rejected",
      code: "camera_control_failed",
      message:
        (
          result.message ??
          result.targets
            .filter((target) => target.outcome === "failure")
            .map((target) => target.message)
            .join("; ")
        ).slice(0, 1000) || "Camera control failed",
    };
  return {
    status: "success",
    evidence: {
      kind:
        result.targets.length === 0
          ? "local"
          : result.targets.every(
                (target) =>
                  target.evidence === "confirmed" || target.evidence === "noop",
              )
            ? "state-confirmed"
            : "response",
      summary:
        result.targets.length === 0
          ? "CCC camera selection saved locally"
          : result.targets.every(
                (target) =>
                  target.evidence === "confirmed" || target.evidence === "noop",
              )
            ? "Every targeted camera reached the requested state"
            : "RCP acknowledged delivery; camera completion was not confirmed",
    },
  };
}
