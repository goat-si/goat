import type {
  ProviderInstanceId,
  ProviderSessionId,
  ServerProviderModel,
  ThreadId,
} from "@goat/contracts";
import type { ProviderModelStatus } from "@goat/provider-core/server/ProviderAdapter";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

import type { CodexDetachedAppServers } from "../../provider/CodexDetachedAppServerLive.ts";
import type * as CodexSurvivors from "../../provider/CodexSurvivors.ts";

const offeredFromCatalog = (models: ReadonlyArray<ServerProviderModel>) =>
  new Set(models.flatMap((model) => (model.isCustom ? [] : [model.slug])));

/** A process is not asked again this soon for an answer that lets the turn run. */
const LISTING_QUIET_MS = 60_000;

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
  let asked: { readonly atMs: number; readonly answered: boolean } | undefined;
  let listings = 0;
  let warned = false;
  // Overlapping checks take turns; one that waited behind a listing reuses its answer.
  const listing = Semaphore.makeUnsafe(1);
  const lists = input.listServed.pipe(
    Effect.tap((slugs) => Effect.sync(() => (served = new Set(slugs)))),
    Effect.timeoutOption("10 seconds"),
    Effect.orElseSucceed(() => Option.none()),
    Effect.tap((answer) =>
      Effect.map(Clock.currentTimeMillis, (atMs) => {
        asked = { atMs, answered: Option.isSome(answer) };
        listings += 1;
      }),
    ),
  );
  return Effect.fn("CodexModelArrivals.modelStatus")(function* (
    model: string,
    options?: { readonly cachedOnly?: boolean; readonly since?: number | undefined },
  ) {
    const offered = yield* input.offered;
    const entry = offered.find((candidate) => candidate.slug === model);
    if (entry?.isCustom === true) return "ready" as ProviderModelStatus;
    const catalogued = offeredFromCatalog(offered).size > 0;
    const listingsBefore = listings;
    // Exact: a provider's own catalog matches slugs exactly, and GOAT cannot see which catalog it uses.
    const listed: Option.Option<boolean> =
      served?.has(model) === true
        ? Option.some(true)
        : options?.cachedOnly === true
          ? Option.fromNullishOr(served?.has(model))
          : yield* listing.withPermits(1)(
              Effect.gen(function* () {
                if (served?.has(model) === true) return Option.some(true);
                const last = asked;
                // A listing that finished after this check or its open began is as recent as they are.
                const waited =
                  last !== undefined &&
                  (listings > listingsBefore ||
                    (options?.since !== undefined && last.atMs > options.since));
                const quiet =
                  last !== undefined &&
                  (yield* Clock.currentTimeMillis) - last.atMs < LISTING_QUIET_MS;
                // Codex can learn models online, so a miss that would refuse is always asked again.
                if (waited || (quiet && !(last.answered && catalogued)))
                  return last.answered ? Option.some(false) : Option.none<boolean>();
                return Option.map(yield* lists, (slugs) => slugs.includes(model));
              }),
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
    if (entry === undefined) return catalogued ? "missing" : "unconfirmed";
    return atStart.has(model) ? "missing" : "predated";
  });
};
