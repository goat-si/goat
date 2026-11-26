import type { ProviderDriverKind } from "@goat/contracts";
import type { ProviderAdapterV2TurnInput } from "@goat/provider-core/server/ProviderAdapter";
import * as MemoryContext from "@goat/provider-core/server/memoryContext";
import * as EffectAcpErrors from "effect-acp/errors";
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

/** Validate the initial selection before returning from startTurn. Each resend gets a fresh selection and receipt. */
export const preparePromptMemory = Effect.fnUntraced(function* (
  input: ProviderAdapterV2TurnInput | undefined,
  driver: ProviderDriverKind,
) {
  const select = MemoryContext.selectSnapshot(input, driver);
  let initial: { snapshot: Effect.Success<typeof select> } | undefined = {
    snapshot: yield* select,
  };
  return Effect.fnUntraced(function* <A>(
    context: ActiveAcpTurn,
    send: (
      memory: ReadonlyArray<EffectAcpSchema.ContentBlock>,
      beforeDispatch: Effect.Effect<ReadonlyArray<EffectAcpSchema.ContentBlock>>,
    ) => Effect.Effect<A, EffectAcpErrors.AcpError>,
  ) {
    const selected = initial
      ? initial.snapshot
      : yield* select.pipe(
          Effect.mapError(() =>
            EffectAcpErrors.AcpRequestError.internalError(
              "Could not prepare GOAT memory for the prompt.",
            ),
          ),
        );
    initial = undefined;
    let snapshot = yield* MemoryContext.admitSelected(input, selected);
    const blocks: ReadonlyArray<EffectAcpSchema.ContentBlock> = snapshot
      ? [{ type: "text", text: MemoryContext.memoryContextText(snapshot) }]
      : [];
    const confirm = yield* Effect.cached(
      Effect.suspend(() => MemoryContext.deliveryReceipt(input, snapshot)),
    );
    context.confirmMemory = confirm;
    const beforeDispatch = Effect.gen(function* () {
      snapshot = yield* MemoryContext.recheckSnapshot(input, snapshot);
      return snapshot ? blocks : [];
    });
    return yield* send(blocks, beforeDispatch).pipe(
      Effect.tap(() => confirm),
      Effect.ensuring(
        Effect.sync(() => {
          if (context.confirmMemory === confirm) delete context.confirmMemory;
        }),
      ),
    );
  });
});
