import { expect, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { existingThreadIdsForCommand } from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("A thread notice must not start a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layer = ProviderReplayHarness.layerWithRegistry(
  { name: "thread-notice" },
  ProviderAdapterRegistry.layerFromAdapters([adapter]),
  { databaseLayer: SqlitePersistence.layerMemory, runEffectWorker: false },
);

const createThread = (threadId: ThreadId) =>
  Orchestrator.OrchestratorV2.use((orchestrator) =>
    orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:thread-notice"),
      title: "Ordinary thread",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    }),
  );

it.effect("updates one runless notice when a record key is redelivered", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const threadId = ThreadId.make("thread:notice-update");
    yield* createThread(threadId);
    const command = {
      type: "thread.notice.record" as const,
      commandId: CommandId.make("notice:first"),
      threadId,
      recordKey: "handoff:one",
      message: "Sync started",
    };
    expect(existingThreadIdsForCommand(command)).toEqual([threadId]);

    // dispatch resolves after the event transaction commits; no worker or polling is needed.
    const first = yield* orchestrator.dispatch(command);
    expect(first.storedEvents.map(({ event }) => event.type)).toEqual(["turn-item.updated"]);
    const initial = (yield* projections.getThreadProjection(threadId)).turnItems[0]!;
    const updatedCommand = {
      ...command,
      commandId: CommandId.make("notice:updated"),
      message: "Sync completed",
    };
    const second = yield* orchestrator.dispatch(updatedCommand);
    expect(second.storedEvents.map(({ event }) => event.type)).toEqual(["turn-item.updated"]);
    const projection = yield* projections.getThreadProjection(threadId);
    expect(projection.turnItems).toHaveLength(1);
    const item = projection.turnItems[0]!;
    expect(item).toMatchObject({
      id: initial.id,
      ordinal: initial.ordinal,
      type: "system_notice",
      message: "Sync completed",
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      status: "completed",
    });
    expect(DateTime.formatIso(item.startedAt!)).toBe(DateTime.formatIso(initial.startedAt!));
    expect(DateTime.formatIso(item.completedAt!)).toBe(DateTime.formatIso(initial.completedAt!));
    expect(projection.runs).toEqual([]);
    expect(projection.nodes).toEqual([]);
    expect(projection.providerSessions).toEqual([]);
    expect(yield* outbox.listByCommandId(command.commandId)).toEqual([]);
    expect(yield* outbox.listByCommandId(updatedCommand.commandId)).toEqual([]);

    const replay = yield* orchestrator.dispatch(updatedCommand);
    expect(replay.sequence).toBe(second.sequence);
    expect((yield* projections.getThreadProjection(threadId)).turnItems).toHaveLength(1);
  }).pipe(Effect.provide(layer)),
);

it.effect("keeps distinct record keys and the same key on different threads separate", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:notice-keys");
    const otherThreadId = ThreadId.make("thread:notice-other");
    yield* createThread(threadId);
    yield* createThread(otherThreadId);
    for (const [target, key] of [
      [threadId, "one"],
      [threadId, "two"],
      [otherThreadId, "one"],
    ] as const) {
      yield* orchestrator.dispatch({
        type: "thread.notice.record",
        commandId: CommandId.make(`notice:${target}:${key}`),
        threadId: target,
        recordKey: key,
        message: `Notice ${key}`,
      });
    }
    const projection = yield* projections.getThreadProjection(threadId);
    const other = yield* projections.getThreadProjection(otherThreadId);
    expect(projection.turnItems).toHaveLength(2);
    expect(other.turnItems).toHaveLength(1);
    expect(new Set([...projection.turnItems, ...other.turnItems].map((item) => item.id)).size).toBe(
      3,
    );
    expect(projection.turnItems[1]!.ordinal).toBeGreaterThan(projection.turnItems[0]!.ordinal);
    expect(projection.runs).toEqual([]);
    expect(other.runs).toEqual([]);
  }).pipe(Effect.provide(layer)),
);

it.effect("rejects a notice for a nonexistent thread", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const commandId = CommandId.make("notice:missing");
    const error = yield* orchestrator
      .dispatch({
        type: "thread.notice.record",
        commandId,
        threadId: ThreadId.make("thread:missing"),
        recordKey: "one",
        message: "Cannot record this",
      })
      .pipe(Effect.flip);
    expect(error._tag).toBe("OrchestratorProjectionError");
    expect(yield* outbox.listByCommandId(commandId)).toEqual([]);
  }).pipe(Effect.provide(layer)),
);

it.effect("allows archived threads and rejects deleted threads", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:notice-archived");
    yield* createThread(threadId);
    yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("archive:notice"),
      threadId,
    });
    yield* orchestrator.dispatch({
      type: "thread.notice.record",
      commandId: CommandId.make("notice:archived"),
      threadId,
      recordKey: "one",
      message: "Still visible in history",
    });
    yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("delete:notice"),
      threadId,
    });
    const error = yield* orchestrator
      .dispatch({
        type: "thread.notice.record",
        commandId: CommandId.make("notice:deleted"),
        threadId,
        recordKey: "two",
        message: "Cannot append after deletion",
      })
      .pipe(Effect.flip);
    expect(error._tag).toBe("OrchestratorDispatchError");
    expect((yield* projections.getThreadProjection(threadId)).turnItems).toHaveLength(1);
  }).pipe(Effect.provide(layer)),
);
