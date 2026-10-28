import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/** ToolAdmission exposes only the reservation this call successfully holds. */
export class LifecycleAdmissionReceipt extends Context.Service<
  LifecycleAdmissionReceipt,
  { readonly held: Effect.Effect<string | undefined> }
>()("goat/mcp/LifecycleAdmissionReceipt") {}
