import type { ModelSelection, OrchestratorMcpCapabilitiesResult } from "@goat/contracts";
import * as Effect from "effect/Effect";

/**
 * Whether a remote GOAT's provider offers the selected model. The remote caches its
 * provider's catalog, so a miss refreshes that instance once before the answer is final:
 * a model added there since the last probe (for example by `ocx sync`) then appears.
 */
export const remoteModelOffer = Effect.fn("SshRemoteDispatch.remoteModelOffer")(function* <
  E,
  RefreshError,
  R,
>(input: {
  readonly selection: Pick<ModelSelection, "instanceId" | "model">;
  readonly capabilities: Effect.Effect<OrchestratorMcpCapabilitiesResult, E, R>;
  readonly refresh: Effect.Effect<unknown, RefreshError, R>;
}) {
  const offer = Effect.map(input.capabilities, ({ providers }) => {
    const provider = providers.find(
      (entry) => entry.providerInstanceId === input.selection.instanceId,
    );
    if (provider === undefined) return "no_instance" as const;
    return provider.models.some((model) => model.id === input.selection.model)
      ? ("offered" as const)
      : ("missing" as const);
  });
  const first = yield* offer;
  if (first !== "missing") return first;
  yield* Effect.ignore(input.refresh);
  return yield* offer;
});
