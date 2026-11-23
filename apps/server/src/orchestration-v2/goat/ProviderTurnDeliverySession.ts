import * as Effect from "effect/Effect";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import { refusedBeforePrompt } from "../PromptRefusal.ts";
import type { ProviderDriverKind } from "@goat/contracts";

export const makeDeliverySession = (
  session: ProviderAdapter.ProviderAdapterV2SessionRuntime,
  startWithHandoffs: (
    input: Parameters<ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"]>[0],
    compact?: boolean,
  ) => ReturnType<ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"]>,
) => {
  let deliver: typeof startWithHandoffs | undefined = startWithHandoffs;
  const start = (
    input: Parameters<ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"]>[0],
    compact = false,
  ) =>
    Effect.suspend(() => {
      if (deliver !== undefined) return deliver(input, compact);
      return compact && session.compactThread !== undefined
        ? session.compactThread(input)
        : session.startTurn(input);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          deliver = undefined;
        }),
      ),
    );
  return {
    ...session,
    startTurn: (input: Parameters<typeof session.startTurn>[0]) => start(input),
    ...(session.compactThread === undefined
      ? {}
      : {
          compactThread: (input: Parameters<typeof session.startTurn>[0]) => start(input, true),
        }),
  };
};

export const submitWithContextHandoff = Effect.fn(
  "ProviderTurnStartService.submitWithContextHandoff",
)(function* <PersistError>(
  start: ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"],
  input: ProviderAdapter.ProviderAdapterV2TurnInput,
  delivery: {
    readonly delivered: Effect.Effect<void, PersistError>;
    readonly unsent: Effect.Effect<void, PersistError>;
  },
  context: string,
  driver?: ProviderDriverKind,
) {
  const text = input.message.text;
  const prefix = context === "" ? "" : `${context}\n\nUser message:\n`;
  const unsent = yield* Effect.cached(
    delivery.unsent.pipe(
      Effect.catchCause(() =>
        Effect.logWarning("Failed to restore unsent context handoffs", { runId: input.runId }),
      ),
    ),
  );
  const delivered = yield* Effect.cached(
    delivery.delivered.pipe(
      Effect.catchCause(() =>
        Effect.logWarning("Failed to record accepted context handoff delivery", {
          runId: input.runId,
        }),
      ),
    ),
  );
  const witness = input.inputDelivery;
  yield* start({
    ...input,
    ...(witness === undefined
      ? {}
      : {
          inputDelivery: {
            ...witness,
            begin: () =>
              witness.begin().pipe(Effect.tap((began) => (began ? Effect.void : unsent))),
            skipped: () => witness.skipped().pipe(Effect.andThen(unsent)),
            submitted: () =>
              witness
                .submitted()
                .pipe(Effect.andThen(driver === "cursor" ? Effect.void : delivered)),
            accepted: () =>
              witness
                .accepted()
                .pipe(Effect.andThen(driver === "cursor" ? delivered : Effect.void)),
          },
        }),
    message: { ...input.message, text: prefix + text },
    ...(prefix === "" ? {} : { inlineContextLength: prefix.length }),
  }).pipe(Effect.tapError((error) => (refusedBeforePrompt(error) ? unsent : Effect.void)));
});
