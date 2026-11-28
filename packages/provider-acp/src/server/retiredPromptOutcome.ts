import type { OrchestrationV2ProviderTurn, ProviderDriverKind } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type { AcpAdapterV2Flavor } from "./adapterFlavor.ts";

export function withExecutedProviderTurnModel(
  settledTurn: OrchestrationV2ProviderTurn,
  executedModel: string | undefined,
): OrchestrationV2ProviderTurn {
  if (executedModel === undefined) return settledTurn;
  return {
    ...settledTurn,
    model: executedModel,
    ...(settledTurn.turnTokenUsage === undefined
      ? {}
      : { turnTokenUsage: { ...settledTurn.turnTokenUsage, models: [executedModel] } }),
  };
}

export type PromptOutcomeCheck = Effect.Success<
  ReturnType<NonNullable<AcpAdapterV2Flavor["watchPromptOutcome"]>>
>;

export function promptOutcomeFailure(outcome: Effect.Success<ReturnType<PromptOutcomeCheck>>) {
  return outcome !== undefined && "resumeWith" in outcome
    ? outcome
    : { failure: outcome, resumeWith: undefined };
}

export const readRetiredPromptOutcome = Effect.fn("AcpAdapterV2.readRetiredPromptOutcome")(
  function* (check: PromptOutcomeCheck | undefined, driver: ProviderDriverKind) {
    if (check === undefined) return undefined;
    return yield* check({ stopReason: "end_turn" }, { retired: true }).pipe(
      Effect.map((outcome) => promptOutcomeFailure(outcome).failure),
      Effect.timeout("5 seconds"),
      Effect.catchCause((cause) =>
        Effect.logError("Failed to check a silent ACP prompt's outcome", { driver, cause }).pipe(
          Effect.as(undefined),
        ),
      ),
    );
  },
);
