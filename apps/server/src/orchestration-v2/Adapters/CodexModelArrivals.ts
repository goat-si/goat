import type { ServerProviderModel } from "@goat/contracts";
import * as Effect from "effect/Effect";

const offeredFromCatalog = (models: ReadonlyArray<ServerProviderModel>) =>
  new Set(models.flatMap((model) => (model.isCustom ? [] : [model.slug])));

/**
 * Codex's app-server reads its catalog only at startup and runs an unknown model on fallback metadata
 * that sends every MCP tool inline. A model predates the process when GOAT began offering it after the
 * process started and the process does not list it; custom models and failed listings never count.
 */
export const makeCodexModelArrivals = <E>(input: {
  /** The models GOAT offered just before this process started. */
  readonly atStart: ReadonlyArray<ServerProviderModel>;
  /** The models GOAT offers for this provider instance now. */
  readonly offered: Effect.Effect<ReadonlyArray<ServerProviderModel>>;
  /** The slugs the process serving this session lists. */
  readonly listServed: Effect.Effect<ReadonlyArray<string>, E>;
}) => {
  const atStart = offeredFromCatalog(input.atStart);
  let served: ReadonlySet<string> | undefined;
  const lists = Effect.fn("CodexModelArrivals.lists")(function* (model: string) {
    if (served?.has(model)) return true;
    // Codex can still learn models online, so a miss is asked again.
    served = new Set(yield* input.listServed);
    return served.has(model);
  });
  return Effect.fn("CodexModelArrivals.predatesModel")(function* (model: string) {
    if (atStart.has(model) || !offeredFromCatalog(yield* input.offered).has(model)) return false;
    return !(yield* lists(model).pipe(
      Effect.timeoutOption("10 seconds"),
      Effect.map((listed) => listed._tag === "None" || listed.value),
      Effect.orElseSucceed(() => true),
    ));
  });
};
