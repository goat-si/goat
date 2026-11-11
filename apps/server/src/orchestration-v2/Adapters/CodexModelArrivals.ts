import type {
  ProviderInstanceId,
  ProviderSessionId,
  ServerProviderModel,
  ThreadId,
} from "@goat/contracts";
import type { ProviderModelStatus } from "@goat/provider-core/server/ProviderAdapter";
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

/** Every slug the serving process can run, hidden ones included: the picker hides them, Codex does not. */
export const listCodexModelSlugs = Effect.fn("CodexModelArrivals.listCodexModelSlugs")(function* <
  E,
>(
  request: (params: { readonly includeHidden: true; readonly cursor?: string }) => Effect.Effect<
    {
      readonly data: ReadonlyArray<{ readonly model: string }>;
      readonly nextCursor?: string | null;
    },
    E
  >,
) {
  const slugs: Array<string> = [];
  let cursor: string | null | undefined;
  do {
    const page: {
      readonly data: ReadonlyArray<{ readonly model: string }>;
      readonly nextCursor?: string | null;
    } = yield* request(cursor ? { includeHidden: true, cursor } : { includeHidden: true });
    for (const listed of page.data) slugs.push(listed.model);
    cursor = page.nextCursor;
  } while (cursor);
  return slugs;
});

/**
 * Codex's app-server reads its catalog only at startup and runs a model it cannot resolve with every
 * MCP tool inline. Otherwise a model is predated (offered only after the process started), missing
 * (offered then too, or absent from GOAT's catalog) or unconfirmed (no answer, or no catalog yet).
 * Custom models are GOAT's and never checked.
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
  let warned = false;
  const lists = Effect.fn("CodexModelArrivals.lists")(function* (model: string) {
    if (served?.has(model)) return true;
    // Codex can still learn models online, so a miss is asked again.
    served = new Set(yield* input.listServed);
    // Exact: a provider's own catalog matches slugs exactly, and GOAT cannot see which catalog it uses.
    return served.has(model);
  });
  return Effect.fn("CodexModelArrivals.modelStatus")(function* (
    model: string,
    options?: { readonly cachedOnly?: boolean },
  ) {
    const offered = yield* input.offered;
    const entry = offered.find((candidate) => candidate.slug === model);
    if (entry?.isCustom === true) return "ready" as ProviderModelStatus;
    const listed =
      options?.cachedOnly === true
        ? Option.fromNullishOr(served?.has(model))
        : yield* lists(model).pipe(
            Effect.timeoutOption("10 seconds"),
            Effect.orElseSucceed(() => Option.none<boolean>()),
          );
    if (Option.isNone(listed)) {
      if (!warned && options?.cachedOnly !== true)
        yield* Effect.logWarning("Codex did not list its models; its turns run unchecked", {
          model,
        });
      warned ||= options?.cachedOnly !== true;
      return "unconfirmed";
    }
    if (listed.value) return "ready";
    // A pending or failed probe publishes no catalog, so GOAT cannot tell what a new process knows.
    if (entry === undefined)
      return offeredFromCatalog(offered).size > 0 ? "missing" : "unconfirmed";
    return atStart.has(model) ? "missing" : "predated";
  });
};
