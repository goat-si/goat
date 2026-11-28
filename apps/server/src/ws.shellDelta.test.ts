import { assert, it } from "@effect/vitest";
import type { ProjectId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import { makeShellDeltaLoads } from "./orchestration-v2/ShellDeltaLoads.ts";
import * as ShellSnapshotLoads from "./orchestration-v2/ShellSnapshotLoads.ts";
import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as OrchestrationEventStore from "./persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as ProjectEnrichment from "./project/ProjectEnrichmentService.ts";
import * as ProjectService from "./project/ProjectService.ts";
import { subscribeOrchestrationV2Shell } from "./ws.ts";

const ReplayTestLayer = OrchestrationEventStore.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

it.effect("three replaying shell subscribers share the projected read for one change", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* OrchestrationEventStore.OrchestrationEventStore;
    const changes = yield* PubSub.unbounded();
    const joined = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    type Load = ReturnType<ShellSnapshotLoads.ShellSnapshotLoads["Service"]["projectDeltas"]>;
    const deltas = yield* makeShellDeltaLoads<Effect.Success<Load>[number], Effect.Error<Load>>();
    let subscribers = 0;
    let reads = 0;
    yield* sql`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, actor_kind, payload_json, metadata_json, application_event_version
      ) VALUES (
        'delta:event', 'project', 'project:delta', 1, 'project.meta-updated',
        '2026-01-05T00:00:00.000Z', 'server',
        '{"projectId":"project:delta","updatedAt":"2026-01-05T00:00:00.000Z"}', '{}', 2
      )
    `;
    const parts: Effect.Success<
      ReturnType<ShellSnapshotLoads.ShellSnapshotLoads["Service"]["active"]>
    > = {
      projects: [],
      threads: { schemaVersion: 1, snapshotSequence: 0, threads: [], archivedThreads: [] },
      shellIndex: undefined,
      snapshotSequence: 0,
    };
    const subscription = subscribeOrchestrationV2Shell({}).pipe(
      Effect.flatMap((stream) => stream.pipe(Stream.take(2), Stream.runCollect)),
      Effect.provideService(ShellSnapshotLoads.ShellSnapshotLoads, {
        active: () => Effect.succeed(parts),
        projectDeltas: (events, project) =>
          Effect.sync(() => ++subscribers).pipe(
            Effect.flatMap((count) =>
              count === 3 ? Deferred.succeed(joined, undefined) : Effect.void,
            ),
            Effect.andThen(deltas.run(events, project)),
          ),
      }),
      Effect.provideService(OrchestrationEventStore.OrchestrationEventStore, {
        ...store,
        streamProjectedApplicationEvents: (input) =>
          store.streamProjectedApplicationEvents(input).pipe(Stream.take(1)),
      }),
      Effect.provideService(
        ThreadManagement.ThreadManagementService,
        {} as ThreadManagement.ThreadManagementService["Service"],
      ),
      Effect.provideService(
        ProjectStore.ProjectStoreV2,
        {} as ProjectStore.ProjectStoreV2["Service"],
      ),
      Effect.provideService(ProjectService.ProjectService, {
        getShell: (id: ProjectId) =>
          Effect.sync(() => {
            reads++;
          }).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(
              Option.some({
                id,
                title: id,
                workspaceRoot: `/workspace/${id}`,
                defaultModelSelection: null,
                scripts: [],
                createdAt: "2026-01-05T00:00:00.000Z",
                updatedAt: "2026-01-05T00:00:00.000Z",
              }),
            ),
          ),
      } as unknown as ProjectService.ProjectService["Service"]),
      Effect.provideService(ProjectEnrichment.ProjectEnrichmentService, {
        subscribeChanges: PubSub.subscribe(changes),
      } as ProjectEnrichment.ProjectEnrichmentService["Service"]),
    );
    const fibers = yield* Effect.forEach([1, 2, 3], () =>
      subscription.pipe(Effect.forkChild({ startImmediately: true })),
    );
    yield* Deferred.await(joined);
    yield* Deferred.succeed(release, undefined);
    const results = yield* Effect.forEach(fibers, Fiber.join);
    assert.equal(reads, 1);
    for (const items of results) {
      assert.deepEqual(
        items.map((item) => item.kind),
        ["snapshot", "project.updated"],
      );
      assert.equal("sequence" in items[1]! ? items[1].sequence : null, 1);
    }
  }).pipe(Effect.scoped, Effect.provide(ReplayTestLayer)),
);
