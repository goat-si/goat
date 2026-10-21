import { OrchestratorMcpFailure, type HostPressureAdvice } from "@goat/contracts";
import * as Effect from "effect/Effect";

import * as PressureNudger from "../fleet/pressure/PressureNudger.ts";

/**
 * Soft admission for launch tools (ADR-0020): advice to return beside the result when the target
 * host is under pressure, or a refusal when fleet.pressure.admission is "block" and it is critical.
 * Reads only what this machine already knows, so a launch never waits on a status probe.
 */
export const admitLaunch = Effect.fn("admitLaunch")(function* (host: string | null) {
  const nudger = yield* Effect.serviceOption(PressureNudger.PressureNudger);
  if (nudger._tag === "None") return undefined;
  const admission = yield* nudger.value.admit(host);
  if (admission.refuse && admission.advice !== undefined)
    return yield* new OrchestratorMcpFailure({
      code: "host_pressure",
      message:
        admission.advice.message +
        " The fleet.pressure.admission setting is block, so this launch was refused.",
    });
  return admission.advice;
});

export const withPressure = <A extends object>(
  result: A,
  advice: HostPressureAdvice | undefined,
) => (advice === undefined ? result : { ...result, pressure: advice });
