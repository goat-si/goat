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
  return Effect.fn("MemorySyncService.pullTail")(function* (
    r: R,
    budget: { pages: number; entries: number },
  ) {
    if (!r.space) return yield* new M.MemoryHubError({ code: "bootstrap_required" });
    const space = r.space;
    let highWatermark: number | undefined;
    while (budget.pages < 10 && budget.entries < 1000) {
      const after = yield* store.readCursor(space, r.hubId);
      const page = yield* callPull(r, {
        protocolVersion: 1,
        memorySpaceId: space,
        environmentId: local,
        afterSequence: after,
        limit: Math.min(100, 1000 - budget.entries),
        ...(highWatermark === undefined ? {} : { highWatermark }),
      }).pipe(
        Effect.flatMap(decodePull),
        Effect.mapError((e) =>
          e._tag === "SchemaError" ? new M.MemoryHubError({ code: "invalid_output" }) : e,
        ),
      );
      yield* ensureEpoch(r.settings.memoryHubVersion);
      if (
        page.checkpoint ||
        (highWatermark !== undefined && page.highWatermark !== highWatermark) ||
        page.throughSequence < after ||
        (page.hasMore && page.throughSequence === after)
      )
        return yield* new M.MemoryHubError({ code: "invalid_output" });
      highWatermark = page.highWatermark;
      yield* service.receiveHubPage({
        memorySpaceId: space,
        hubEnvironmentId: r.hubId,
        localEnvironmentId: local,
        expectedSequence: after,
        page,
        reauthorize: ensureEpoch(r.settings.memoryHubVersion),
      });
      budget.pages++;
      budget.entries += page.entries.length;
      if (!page.hasMore) break;
    }
  });
};
