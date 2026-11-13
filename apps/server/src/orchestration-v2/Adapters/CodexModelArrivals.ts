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
import { makeCodexCatalogFreshness } from "./CodexCatalogFreshness.ts";

const offeredFromCatalog = (models: ReadonlyArray<ServerProviderModel>) =>
  new Set(models.flatMap((model) => (model.isCustom ? [] : [model.slug])));

/** A process is not asked again this soon for an answer that lets the turn run. */
const LISTING_QUIET_MS = 60_000;

/**
 * What the process this open reaches read at startup: the models GOAT offered then and when it
 * started. A process kept from an earlier GOAT run is found as the client factory finds it; what
 * GOAT offers now says nothing about it, and an unknown start counts as before any catalog change.
 * Undefined when GOAT offers no catalog to check against.
 */
export const codexProcessStart = Effect.fn("CodexModelArrivals.codexProcessStart")(
  function* (input: {
    readonly detached: Option.Option<CodexDetachedAppServers["Service"]>;
    readonly survivors: Option.Option<CodexSurvivors.CodexSurvivors["Service"]>;
    readonly instanceId: ProviderInstanceId;
    readonly providerSessionId: ProviderSessionId;
    readonly threadId: ThreadId;
    readonly offeredModels?: Effect.Effect<ReadonlyArray<ServerProviderModel>> | undefined;
  }) {
    const offered = input.offeredModels;
    if (offered === undefined) return undefined;
    const detached = Option.getOrUndefined(input.detached);
    const kept =
      (detached === undefined
        ? undefined
        : (yield* detached.listPreservedForSession(
            input.instanceId,
            input.providerSessionId,
          ))[0]) ??
      (Option.isNone(input.survivors)
        ? undefined
        : (yield* input.survivors.value.get(input.instanceId, input.threadId))?.recordName);
    if (kept === undefined)
      return { offered, atStart: yield* offered, startedAtMs: yield* Clock.currentTimeMillis };
    const startedAtMs = detached === undefined ? undefined : yield* detached.keptStartedAt(kept);
    return { offered, atStart: [], startedAtMs: startedAtMs ?? 0 };
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
 * MCP tool inline. A model is predated (offered only after start), missing (offered then too, or not
 * in GOAT's catalog), unconfirmed (no answer or catalog yet), or outdated (its catalog entry changed
 * since start). Custom models are GOAT's and never checked.
 */
export const makeCodexModelArrivals = <E>(input: {
  /** The models GOAT offered just before this process started; empty when that is unknown. */
  readonly atStart: ReadonlyArray<ServerProviderModel>;
  /** The models GOAT offers for this provider instance now. */
  readonly offered: Effect.Effect<ReadonlyArray<ServerProviderModel>>;
  /** The slugs the process serving this session lists. */
  readonly listServed: Effect.Effect<ReadonlyArray<string>, E>;
  /** When the process started; with `catalog`, models whose catalog entry changed since are outdated. */
  readonly startedAtMs?: number;
  readonly catalog?: Omit<Parameters<typeof makeCodexCatalogFreshness>[0], "startedAtMs">;
}) => {
  const atStart = offeredFromCatalog(input.atStart);
  const outdated =
    input.catalog &&
    input.startedAtMs !== undefined &&
    makeCodexCatalogFreshness({ ...input.catalog, startedAtMs: input.startedAtMs });
  let served: ReadonlySet<string> | undefined;
  /** The last listing: when it ended, whether the process answered, and GOAT's catalog then. */
  let asked:
    | { readonly atMs: number; readonly answered: boolean; readonly catalog: string }
    | undefined;
  let listings = 0;
  let warned = false;
  // Overlapping checks take turns; one that waited behind a listing reuses its answer.
  const listing = Semaphore.makeUnsafe(1);
  const lists = (catalog: string) =>
    input.listServed.pipe(
      Effect.tap((slugs) => Effect.sync(() => (served = new Set(slugs)))),
      Effect.timeoutOption("10 seconds"),
      Effect.orElseSucceed(() => Option.none()),
      Effect.tap((answer) =>
        Effect.map(Clock.currentTimeMillis, (atMs) => {
          asked = { atMs, answered: Option.isSome(answer), catalog };
          listings += 1;
        }),
      ),
    );
  const arrival = Effect.fnUntraced(function* (
    model: string,
    options?: { readonly cachedOnly?: boolean; readonly since?: number | undefined },
  ) {
    const offered = yield* input.offered;
    const entry = offered.find((candidate) => candidate.slug === model);
    if (entry?.isCustom === true) return "ready" as ProviderModelStatus;
    const catalogSlugs = offeredFromCatalog(offered);
    const catalogued = catalogSlugs.size > 0;
    const catalog = [...catalogSlugs].sort().join("\n");
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
                // Codex can learn models online: a miss refuses only from a listing as recent as the
                // check, taken under the catalog GOAT holds now.
                const refuses = last !== undefined && last.answered && catalogued;
                const reuse = waited ? !refuses || last.catalog === catalog : quiet && !refuses;
                if (last !== undefined && reuse)
                  return last.answered ? Option.some(false) : Option.none<boolean>();
                return Option.map(yield* lists(catalog), (slugs) => slugs.includes(model));
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
  return Effect.fn("CodexModelArrivals.modelStatus")(function* (
    model: string,
    options?: { readonly cachedOnly?: boolean; readonly since?: number | undefined },
  ) {
    const status = yield* arrival(model, options);
    if (status !== "ready" && status !== "unconfirmed") return status;
    if (!outdated || (yield* input.offered).some((entry) => entry.slug === model && entry.isCustom))
      return status;
    return (yield* outdated(model, options)) ? "outdated" : status;
  });
};
