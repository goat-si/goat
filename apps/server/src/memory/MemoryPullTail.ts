import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Hub from "./MemoryHubService.ts";
import type * as Client from "./MemoryHubClient.ts";
import type * as Store from "./MemoryStore.ts";
import type * as Service from "./MemoryService.ts";
type TailRoute = {
  readonly space: M.MemorySpaceId | null;
  readonly hubId: M.EnvironmentId;
  readonly settings: { readonly memoryHubVersion: number };
};

const decodePull = Schema.decodeUnknownEffect(M.MemoryHubPullResult);

export const makePullMemoryTail = <R extends TailRoute>(deps: {
  store: Store.MemoryStore["Service"];
  service: Service.MemoryService["Service"];
  callPull: (
    route: R,
    input: M.MemoryHubPullInput,
  ) => Effect.Effect<M.MemoryHubPullResult, Hub.MemoryHubServiceError | Client.HubClientFailure>;
  ensureEpoch: (epoch: number) => Effect.Effect<void, Service.MemoryAccessError>;
  local: M.EnvironmentId;
}) => {
  const { store, service, callPull, ensureEpoch, local } = deps;
  const pull = (route: R, input: M.MemoryHubPullInput) =>
    callPull(route, input).pipe(
      Effect.flatMap(decodePull),
      Effect.mapError((e) =>
        e._tag === "SchemaError" ? new M.MemoryHubError({ code: "invalid_output" }) : e,
      ),
    );
  return Effect.fn("MemorySyncService.pullTail")(function* (
    r: R,
    budget: { pages: number; entries: number },
  ) {
    if (!r.space) return yield* new M.MemoryHubError({ code: "bootstrap_required" });
    const space = r.space;
    let highWatermark: number | undefined;
    let catchUpOrigins = true;
    while (budget.pages < 10 && budget.entries < 1000) {
      const after = yield* store.readCursor(space, r.hubId);
      const afterOriginSequence = yield* store.readOriginCursor(space, r.hubId);
      const ordinary = {
        protocolVersion: 1 as const,
        memorySpaceId: space,
        environmentId: local,
        afterSequence: after,
        limit: Math.min(100, 1000 - budget.entries),
        ...(highWatermark === undefined ? {} : { highWatermark }),
      };
      const page = yield* pull(
        r,
        catchUpOrigins ? { ...ordinary, afterOriginSequence } : ordinary,
      ).pipe(
        Effect.catchTags({
          MemoryHubError: (error) => {
            if (
              !catchUpOrigins ||
              (error.code !== "payload_too_large" && error.code !== "invalid_output")
            )
              return Effect.fail(error);
            catchUpOrigins = false;
            return pull(r, ordinary);
          },
        }),
        Effect.catchTags({
          MemoryHubError: (error) =>
            error.code !== "cursor_expired"
              ? Effect.fail(error)
              : store
                  .transact(
                    ensureEpoch(r.settings.memoryHubVersion).pipe(
                      Effect.andThen(
                        store.resetExpiredTailTx({
                          memorySpaceId: space,
                          hubEnvironmentId: r.hubId,
                          expectedSequence: after,
                        }),
                      ),
                    ),
                  )
                  .pipe(Effect.andThen(Effect.fail(error))),
        }),
      );
      yield* ensureEpoch(r.settings.memoryHubVersion);
      if (
        page.checkpoint ||
        (highWatermark !== undefined && page.highWatermark !== highWatermark) ||
        page.throughSequence < after ||
        (page.hasMore && page.throughSequence === after)
      )
        return yield* new M.MemoryHubError({ code: "invalid_output" });
      highWatermark = page.hasMore ? page.highWatermark : undefined;
      yield* service.receiveHubPage({
        memorySpaceId: space,
        hubEnvironmentId: r.hubId,
        localEnvironmentId: local,
        expectedSequence: after,
        afterOriginSequence,
        page,
        reauthorize: ensureEpoch(r.settings.memoryHubVersion),
      });
      budget.pages++;
      budget.entries += page.entries.length;
      if (!page.hasMore && !page.originCatchupPending) {
        if (!page.originPage?.hasMore) break;
        if ((yield* store.readOriginCursor(space, r.hubId)) === afterOriginSequence) break;
      }
    }
  });
};
