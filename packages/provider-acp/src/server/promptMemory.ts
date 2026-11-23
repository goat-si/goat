import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as EffectAcpSchema from "effect-acp/compat";
import type { ActiveAcpTurn } from "./activeTurn.ts";
import type { AcpAdapterV2Flavor } from "./adapterFlavor.ts";
import { acpPostSettleWakeEvidence } from "./wakeEvidence.ts";

// Only post-dispatch output already attributed to the foreground root can acknowledge its prompt.
export const confirmPromptMemory = Effect.fnUntraced(function* (
  context: ActiveAcpTurn,
  notification: EffectAcpSchema.SessionNotification,
  flavor: Pick<AcpAdapterV2Flavor, "extractBackgroundToolMutation">,
) {
  if (
    context.confirmMemory === undefined ||
    context.promptSettled ||
    !acpPostSettleWakeEvidence(notification, flavor) ||
    !(yield* Deferred.isDone(context.promptDispatched))
  )
    return;
  yield* context.confirmMemory;
  delete context.confirmMemory;
});
