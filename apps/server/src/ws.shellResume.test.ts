import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as ShellSnapshotLoads from "./orchestration-v2/ShellSnapshotLoads.ts";
import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";
import * as EventStore from "./persistence/OrchestrationEventStore.ts";
import * as ProjectEnrichment from "./project/ProjectEnrichmentService.ts";
import * as ProjectService from "./project/ProjectService.ts";
import { subscribeOrchestrationV2Shell } from "./ws.ts";

it.effect(
  "refuses an ahead or large-gap shell cursor over the opted-in socket without a snapshot",
  () =>
    Effect.gen(function* () {
      const updates = yield* PubSub.unbounded<ProjectEnrichment.ProjectEnrichmentChange>();
      const services = Layer.mergeAll(
        Layer.mock(ShellSnapshotLoads.ShellSnapshotLoads)({
          active: () => Effect.die("a refused cursor does not build a socket snapshot"),
        }),
        Layer.mock(EventStore.OrchestrationEventStore)({
          latestApplicationSequence: Effect.succeed(2000),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({}),
        Layer.mock(ProjectStore.ProjectStoreV2)({}),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(ProjectEnrichment.ProjectEnrichmentService)({
          subscribeChanges: PubSub.subscribe(updates),
        }),
      );
      for (const afterSequence of [2001, 999]) {
        const items = yield* subscribeOrchestrationV2Shell({
          afterSequence,
          httpSnapshotFallback: true,
          requestCompletionMarker: true,
        }).pipe(Effect.flatMap(Stream.runCollect), Effect.provide(services));
        assert.deepEqual(Array.from(items), [{ kind: "snapshot-required" }]);
      }
    }),
);
