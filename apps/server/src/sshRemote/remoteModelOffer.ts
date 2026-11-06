import type { ModelSelection, OrchestratorMcpCapabilitiesResult } from "@goat/contracts";
import { goatCallText } from "@goat/contracts/agentSurface/callText";
import * as Effect from "effect/Effect";

import { isModelSelectionMiss } from "../mcp/ModelSelectionValidation.ts";
import { SshRemoteDispatchError } from "./dispatchFailure.ts";

/** Where an agent sees what another machine offers; its own provider.list shows this machine's. */
const remoteCatalogHint = (alias: string) =>
  `${alias} answered from its own model list, not this machine's. See what it offers with ${goatCallText(
    "provider.list",
    `{host:${JSON.stringify(alias)}}`,
  )} (add search to find a model by name), then pass modelSelection with one of those models.`;

/** A destination's own instance or model refusal, kept word for word, plus whose catalog it means. */
export const withRemoteCatalogHint = <E>(error: E, alias: string, model: string | undefined) =>
  error instanceof SshRemoteDispatchError &&
  error.reason === "remote_refused" &&
  model !== undefined &&
  isModelSelectionMiss(error.message)
    ? new SshRemoteDispatchError({
        ...error,
        message: `${error.message} ${remoteCatalogHint(alias)}`,
      })
    : error;

/**
 * Preflight's refusal for a selection that host lacks, and where to look instead. Its catalog
 * is searched for the model: unsearched, the list is a shortlist that can leave it out.
 */
export const remoteModelMiss = (
  offer: "missing" | "no_instance",
  selection: Pick<ModelSelection, "instanceId" | "model">,
  alias: string,
) =>
  new SshRemoteDispatchError({
    reason: "remote_refused",
    remoteCode: "model_unavailable",
    message: `${
      offer === "missing"
        ? `${selection.instanceId} on ${alias} does not offer ${selection.model}, even after refreshing its model list.`
        : `${alias} has no provider instance ${selection.instanceId}.`
    } ${remoteCatalogHint(alias)}`,
  });

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
