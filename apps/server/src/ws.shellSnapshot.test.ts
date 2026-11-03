import { assert, it } from "@effect/vitest";
import type { ProjectId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scheduler from "effect/Scheduler";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

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
it.effect(
  "a subscriber joining a shell snapshot read replays every event after its sequence (#2441)",
  () =>
    Effect.gen(function* () {
      const store = yield* OrchestrationEventStore.OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const changes = yield* PubSub.unbounded();
      const started = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const joined = yield* Deferred.make<void>();
      type Parts = Effect.Success<
        ReturnType<ShellSnapshotLoads.ShellSnapshotLoads["Service"]["active"]>
      >;
      type LoadError = Effect.Error<
        ReturnType<ShellSnapshotLoads.ShellSnapshotLoads["Service"]["active"]>
      >;
      const flight = yield* ShellSnapshotLoads.makeSingleFlight<Parts, LoadError>();
      const parts: Parts = {
        projects: [],
        threads: { schemaVersion: 1, snapshotSequence: 0, threads: [], archivedThreads: [] },
        shellIndex: undefined,
        snapshotSequence: 0,
      };
      let loads = 0;
      const load = Effect.sync(() => {
        loads++;
      }).pipe(
        Effect.andThen(Deferred.succeed(started, undefined)),
        Effect.andThen(Deferred.await(gate)),
        Effect.as(parts),
      );
      const owner = yield* flight
        .run(false, load)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(started);
      const insert = (id: string) => sql<{ sequence: number }>`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, actor_kind, payload_json, metadata_json, application_event_version
      ) VALUES (
        ${`join:${id}`}, 'project', ${id}, 1, 'project.meta-updated',
        ${"2026-01-05T00:00:00.000Z"}, 'server',
        ${JSON.stringify({ projectId: id, updatedAt: "2026-01-05T00:00:00.000Z" })}, '{}', 2
      ) RETURNING sequence
    `;
      const [beforeJoin] = yield* insert("project:before-join");
      const subscription = subscribeOrchestrationV2Shell({}).pipe(
        Effect.flatMap((stream) => stream.pipe(Stream.take(3), Stream.runCollect)),
        Effect.provideService(ShellSnapshotLoads.ShellSnapshotLoads, {
          active: () =>
            Deferred.succeed(joined, undefined).pipe(Effect.andThen(flight.run(false, load))),
        }),
        Effect.provideService(OrchestrationEventStore.OrchestrationEventStore, {
          ...store,
          streamProjectedApplicationEvents: (input) =>
            store.streamProjectedApplicationEvents(input).pipe(Stream.take(2)),
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
            Effect.succeedSome({
              id,
              title: id,
              workspaceRoot: `/workspace/${id}`,
              defaultModelSelection: null,
              scripts: [],
              createdAt: "2026-01-05T00:00:00.000Z",
              updatedAt: "2026-01-05T00:00:00.000Z",
            }),
        } as unknown as ProjectService.ProjectService["Service"]),
        Effect.provideService(ProjectEnrichment.ProjectEnrichmentService, {
          subscribeChanges: PubSub.subscribe(changes),
        } as ProjectEnrichment.ProjectEnrichmentService["Service"]),
      );
      const subscriber = yield* subscription.pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(joined);
      const [afterJoin] = yield* insert("project:after-join");
      yield* Deferred.succeed(gate, undefined);
      assert.strictEqual(yield* Fiber.join(owner), parts);
      const items = yield* Fiber.join(subscriber);
      assert.equal(loads, 1);
      assert.equal(items[0]?.kind, "snapshot");
      if (items[0]?.kind === "snapshot") {
        assert.deepEqual(items[0].snapshot, {
          schemaVersion: 1,
          snapshotSequence: 0,
          projects: [],
          threads: [],
          archivedThreads: [],
        });
      }
      assert.deepEqual(
        items.slice(1).map((item) => item.kind),
        ["project.updated", "project.updated"],
      );
      assert.deepEqual(
        items.slice(1).map((item) => ("sequence" in item ? item.sequence : undefined)),
        [beforeJoin!.sequence, afterJoin!.sequence],
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(ReplayTestLayer),
      Effect.provideService(Scheduler.PreventSchedulerYield, true),
    ),
);
