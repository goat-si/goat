import type { OrchestratorMcpFailure } from "@goat/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/** ToolAdmission exposes only the reservation this call successfully holds. */
export class LifecycleAdmissionReceipt extends Context.Service<
  LifecycleAdmissionReceipt,
  {
    readonly held: Effect.Effect<string | undefined>;
    readonly correlate: (correlationId: string) => Effect.Effect<void, OrchestratorMcpFailure>;
  }
>()("goat/mcp/LifecycleAdmissionReceipt") {}
