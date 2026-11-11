import type {
  ProviderInstanceId,
  ProviderSessionId,
  ServerProviderModel,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { CodexDetachedAppServers } from "../../provider/CodexDetachedAppServerLive.ts";
import type * as CodexSurvivors from "../../provider/CodexSurvivors.ts";

const offeredFromCatalog = (models: ReadonlyArray<ServerProviderModel>) =>
  new Set(models.flatMap((model) => (model.isCustom ? [] : [model.slug])));

/** Whether this open reconnects a process kept from an earlier GOAT run, as the client factory does. */
export const reconnectsKeptProcess = Effect.fn("CodexModelArrivals.reconnectsKeptProcess")(
  function* (input: {
    readonly detached: Option.Option<CodexDetachedAppServers["Service"]>;
    readonly survivors: Option.Option<CodexSurvivors.CodexSurvivors["Service"]>;
    readonly instanceId: ProviderInstanceId;
    readonly providerSessionId: ProviderSessionId;
    readonly threadId: ThreadId;
  }) {
    if (Option.isSome(input.detached)) {
      const kept = yield* input.detached.value.listPreservedForSession(
        input.instanceId,
        input.providerSessionId,
      );
      if (kept.length > 0) return true;
    }
    if (Option.isNone(input.survivors)) return false;
    return (yield* input.survivors.value.get(input.instanceId, input.threadId)) !== undefined;
  },
);

/**
 * Codex's app-server reads its catalog only at startup and runs an unknown model on fallback metadata
 * that sends every MCP tool inline. A model predates the process when GOAT began offering it after the
 * process started and the process does not show that it knows it; custom models never count.
 */
export const makeCodexModelArrivals = <E>(input: {
  /** The models GOAT offered just before this process started; empty when that is unknown. */
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
    // A listing that fails or stalls cannot show the process knows the model.
    return !(yield* lists(model).pipe(
      Effect.timeoutOption("10 seconds"),
      Effect.map((listed) => listed._tag === "Some" && listed.value),
      Effect.orElseSucceed(() => false),
    ));
  });
};
