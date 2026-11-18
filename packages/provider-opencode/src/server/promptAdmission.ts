import * as Option from "effect/Option";
import { isOpenCodeRuntimeError } from "./OpenCodeRuntime.ts";
import * as Effect from "effect/Effect";
import type { ActiveOpenCodeTurn } from "./adapterState.ts";

type OpenCodeAdmissionSignal =
  | "accepted"
  | "assistant-completed"
  | "busy"
  | "idle"
  | "user-message";
type OpenCodeAdmissionAction = "hold" | "reconcile-idle" | "release";

export function advanceOpenCodePromptAdmission(
  admission: Pick<
    ActiveOpenCodeTurn,
    "admissionAccepted" | "admissionMessageObserved" | "admissionPending" | "idleDuringAdmission"
  >,
  signal: OpenCodeAdmissionSignal,
): OpenCodeAdmissionAction {
  if (!admission.admissionPending) return "release";
  if (signal === "assistant-completed") {
    admission.admissionAccepted = true;
    admission.admissionMessageObserved = true;
    admission.admissionPending = false;
    return "release";
  }
  if (signal === "idle") {
    admission.idleDuringAdmission = true;
    return "hold";
  }
  if (signal === "accepted") admission.admissionAccepted = true;
  if (signal === "busy" || signal === "user-message") admission.admissionMessageObserved = true;
  if (!admission.admissionAccepted || !admission.admissionMessageObserved) return "hold";
  if (admission.idleDuringAdmission) return "reconcile-idle";
  admission.admissionPending = false;
  return "release";
}

export function cancelOpenCodePromptAdmission(
  admission: Pick<ActiveOpenCodeTurn, "admissionGeneration" | "admissionPending">,
  nextGeneration: number,
): void {
  admission.admissionGeneration = nextGeneration;
  admission.admissionPending = false;
}

export const reconcileOpenCodePromptAdmissionStatus = Effect.fn(
  "reconcileOpenCodePromptAdmissionStatus",
)(function* (
  admission: Pick<ActiveOpenCodeTurn, "admissionGeneration" | "admissionPending">,
  generation: number,
  readStatus: Effect.Effect<"busy" | "idle" | "unknown">,
) {
  if (admission.admissionGeneration !== generation || !admission.admissionPending) {
    return "stale" as const;
  }
  const status = yield* readStatus.pipe(
    Effect.timeoutOption("10 seconds"),
    Effect.map(Option.getOrElse(() => "unknown" as const)),
  );
  if (admission.admissionGeneration !== generation || !admission.admissionPending) {
    return "stale" as const;
  }
  if (status !== "unknown") admission.admissionPending = false;
  return status;
});

const unsentRequestCodes = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

// A reset after sending leaves prompt admission uncertain.
export function isOpenCodePromptRejected(error: unknown): boolean {
  const cause = isOpenCodeRuntimeError(error) ? error.cause : error;
  if (!(cause instanceof Error) || typeof cause.cause !== "object" || cause.cause === null) {
    return false;
  }
  return (
    ("status" in cause.cause && typeof cause.cause.status === "number") ||
    ("code" in cause.cause &&
      typeof cause.cause.code === "string" &&
      unsentRequestCodes.has(cause.cause.code))
  );
}
