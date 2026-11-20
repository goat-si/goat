import { expect, it } from "@effect/vitest";
import { CommandId, EventId, ProjectId, RunId, ThreadId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Sqlite from "./persistence/Sqlite.ts";
import * as EventSink from "./orchestration-v2/EventSink.ts";
import * as EventStore from "./orchestration-v2/EventStore.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import { idleThreadProjection, liveThreadShell } from "./mcp/McpToolAccess.testkit.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import { git, initRepoWithCommit, layerTest, makeTmpDir } from "./vcs/testing/gitFixture.ts";
import { cleanCheckpointRefs } from "./storageCleanupCheckpoints.ts";

const eventLayer = EventSink.layer.pipe(
  Layer.provideMerge(Layer.merge(EventStore.layer, ProjectionStore.layer)),
  Layer.provideMerge(Sqlite.layerMemory),
);
const layer = Layer.merge(layerTest, eventLayer);
it.live("a fork committed during a checkpoint sweep retains its deleted source refs", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sink = yield* EventSink.EventSinkV2;
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const cwd = yield* makeTmpDir("checkpoint-race-");
    yield* initRepoWithCommit(cwd);
    const now = yield* DateTime.now;
    const timestamp = DateTime.formatIso(now);
    yield* sql`INSERT INTO projection_projects ${sql.insert({ project_id: "p", title: "p", workspace_root: cwd, scripts_json: "[]", created_at: timestamp, updated_at: timestamp, deleted_at: null })}`;
    const sourceId = ThreadId.make("race-source");
    const source = {
      ...idleThreadProjection(liveThreadShell(sourceId)).thread,
      projectId: ProjectId.make("p"),
      worktreePath: cwd,
    };
    yield* sink.write({
      events: [
        {
          id: EventId.make("source-created"),
          type: "thread.created",
          threadId: sourceId,
          occurredAt: now,
          payload: source,
        },
      ],
    });
    yield* sql`INSERT INTO orchestration_v2_projection_threads ${sql.insert({ thread_id: "tombstone", project_id: "p", title: "old", default_provider: "codex", runtime_mode: "full-access", interaction_mode: "default", created_at: timestamp, updated_at: timestamp, archived_at: null, deleted_at: timestamp, payload_json: JSON.stringify({ worktreePath: cwd, forkedFrom: null }) })}`;
    const sourceRef = `refs/goat/checkpoints/${Base64Url.encode(sourceId)}/turn/0`;
    const deadRef = `refs/goat/checkpoints/${Base64Url.encode("tombstone")}/turn/0`;
    yield* git(cwd, ["update-ref", sourceRef, "HEAD"]);
    yield* git(cwd, ["update-ref", deadRef, "HEAD"]);
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const blocked = {
      ...driver,
      execute: (input: Parameters<typeof driver.execute>[0]) =>
        input.operation === "StorageCleanup.listCheckpointRefs"
          ? Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(driver.execute(input)),
            )
          : driver.execute(input),
    };
    const sweep = yield* cleanCheckpointRefs(blocked).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Deferred.await(entered);
    const targetId = ThreadId.make("race-fork");
    const committed = yield* sink.commitCommand({
      commandId: CommandId.make("race-fork-command"),
      commandType: "thread.fork",
      threadId: targetId,
      acceptedAt: now,
      effects: [],
      events: [
        {
          id: EventId.make("race-fork-created"),
          type: "thread.created",
          threadId: targetId,
          occurredAt: now,
          payload: {
            ...source,
            id: targetId,
            forkedFrom: { type: "run", threadId: sourceId, runId: RunId.make("source-run") },
          },
        },
      ],
    });
    expect(committed.committed).toBe(true);
    yield* sink.write({
      events: [
        {
          id: EventId.make("source-deleted"),
          type: "thread.deleted",
          threadId: sourceId,
          occurredAt: now,
          payload: { ...source, deletedAt: now },
        },
      ],
    });
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(sweep);
    yield* cleanCheckpointRefs(driver);
    const refs = yield* git(cwd, ["for-each-ref", "--format=%(refname)", "refs/goat/checkpoints/"]);
    expect(refs.split("\n")).toContain(sourceRef);
    expect(refs.split("\n")).not.toContain(deadRef);
  }).pipe(Effect.provide(layer), Effect.scoped),
);
