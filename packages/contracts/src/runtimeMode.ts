// Excerpt from goat-si/goat origin/dev packages/contracts/src/providerPolicy.ts (RuntimeMode,
// ProviderInteractionMode only). The rest of providerPolicy.ts pulls in chatAttachment.ts and is
// not needed by GOAT 2 yet.
import * as Schema from "effect/Schema";

export const RuntimeMode = Schema.Literals([
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
]);
export type RuntimeMode = typeof RuntimeMode.Type;
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";

export const ProviderInteractionMode = Schema.Literals(["default", "plan"]);
export type ProviderInteractionMode = typeof ProviderInteractionMode.Type;
export const DEFAULT_PROVIDER_INTERACTION_MODE: ProviderInteractionMode = "default";
