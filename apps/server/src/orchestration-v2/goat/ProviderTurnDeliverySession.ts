import * as Effect from "effect/Effect";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";

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
