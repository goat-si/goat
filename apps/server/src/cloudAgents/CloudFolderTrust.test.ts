import {
  CommandId,
  EventId,
  ProjectId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
} from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as CloudFolderTrust from "./CloudFolderTrust.ts";

const projectCreated = (sequence: number, workspaceRoot: string) => ({
  sequence,
  aggregateKind: "project",
  type: "project.created",
  payload: { workspaceRoot },
});
const threadUpdated = (sequence: number, worktreePath: string | null) => ({
  sequence,
  commandId: null,
  event: { type: "thread.metadata-updated", payload: { worktreePath } },
});

/** Starts the worker with one trusting provider; each folder it is asked to trust lands in the queue. */
const startWorker = Effect.fn("CloudFolderTrustTest.startWorker")(function* (
  roots: ReadonlyArray<{ readonly workspaceRoot: string; readonly deletedAt: string | null }>,
) {
  const trusted = yield* Queue.unbounded<string>();
  const ensure = (cwd: string) => Queue.offer(trusted, cwd).pipe(Effect.asVoid);
  const service = yield* CloudFolderTrust.make.pipe(
    Effect.provideService(
      ProviderInstanceRegistry.ProviderInstanceRegistry,
      ProviderInstanceRegistry.ProviderInstanceRegistry.of({
        listInstances: Effect.succeed([
          { enabled: true, folderTrust: { ensure } },
          { enabled: false, folderTrust: { ensure: () => Effect.die("disabled instance") } },
          { enabled: true },
        ]),
      } as never),
    ),
    Effect.provideService(
      ProjectStore.ProjectStoreV2,
      ProjectStore.ProjectStoreV2.of({ list: () => Effect.succeed(roots) } as never),
    ),
  );
  yield* service.start();
  return trusted;
});

it.effect("trusts project roots at start, then each new project and worktree once", () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<unknown>();
    let streamedAfter: number | undefined;
    const trusted = yield* startWorker([
      { workspaceRoot: "/projects/goat", deletedAt: null },
      { workspaceRoot: "/projects/gone", deletedAt: "2026-10-01T00:00:00.000Z" },
    ]).pipe(
      Effect.provideService(
        OrchestrationEventStore.OrchestrationEventStore,
        OrchestrationEventStore.OrchestrationEventStore.of({
          latestApplicationSequence: Effect.succeed(7),
          streamProjectedApplicationEvents: (input: {
            readonly afterSequence?: number;
            readonly project: (event: never) => unknown;
          }) => {
            streamedAfter = input.afterSequence;
            return Stream.fromQueue(events).pipe(
              Stream.map((event) => input.project(event as never)),
            );
          },
        } as never),
      ),
    );
    assert.equal(yield* Queue.take(trusted), "/projects/goat");
    assert.equal(streamedAfter, 7);

    yield* Queue.offerAll(events, [
      projectCreated(8, "/projects/new"),
      threadUpdated(9, "/worktrees/goat/feature"),
      threadUpdated(10, null),
      // Every metadata update repeats the worktree; it was already handed over.
      threadUpdated(11, "/worktrees/goat/feature"),
      projectCreated(12, "/projects/last"),
    ]);
    assert.deepEqual(
      [yield* Queue.take(trusted), yield* Queue.take(trusted), yield* Queue.take(trusted)],
      ["/projects/new", "/worktrees/goat/feature", "/projects/last"],
    );
  }).pipe(Effect.scoped),
);

it.effect("keeps trusting new projects after an event larger than the live stream budget", () =>
  Effect.gen(function* () {
    const store = yield* OrchestrationEventStore.OrchestrationEventStore;
    const trusted = yield* startWorker([{ workspaceRoot: "/projects/existing", deletedAt: null }]);
    // The root pass runs after the worker reads where to stream from, so later events reach it.
    assert.equal(yield* Queue.take(trusted), "/projects/existing");
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:large-output");
    const large: OrchestrationV2DomainEvent = {
      id: EventId.make("event:large-output"),
      type: "turn-item.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: TurnItemId.make("tool:large-output"),
        type: "command_execution",
        threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "running",
        title: "Large command",
        // Over the live stream's 8 MiB budget on its own.
        input: "x".repeat(9 * 1024 * 1024),
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      },
    };
    yield* store.publishCommitted(yield* store.appendAgentEvents({ events: [large] }));
    const projectId = ProjectId.make("project:after-large");
    const created = yield* store.appendProjectEvent({
      type: "project.created",
      eventId: EventId.make("event:after-large:created"),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: DateTime.formatIso(now),
      commandId: CommandId.make("command:after-large"),
      causationEventId: null,
      correlationId: null,
      metadata: {},
      payload: {
        projectId,
        title: "After a large event",
        workspaceRoot: "/projects/after-large",
        defaultModelSelection: null,
        scripts: [],
        createdAt: DateTime.formatIso(now),
        updatedAt: DateTime.formatIso(now),
      },
    });
    yield* store.publishCommitted([created]);
    assert.equal(yield* Queue.take(trusted), "/projects/after-large");
  }).pipe(
    Effect.scoped,
    Effect.provide(
      OrchestrationEventStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
    ),
  ),
);
