import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EventId,
  MessageId,
  NodeId,
  ProviderDriverKind,
  RunId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  type ServerSettings,
  type ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import { TestClock } from "effect/testing";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadSettlementService from "./ThreadSettlementService.ts";
import type * as Admission from "./ThreadSettlementService.admission-test-cases.ts";
import type * as Harness from "./ThreadSettlementService.test.ts";

const NOW = "2026-08-27T12:00:00.000Z";
const projectionStoreSql = ProjectionStore.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

type NativeSubagentHarness = Pick<
  typeof Harness,
  "makeHarness" | "makeThread" | "makeSnapshot" | "startHarness"
> &
  Pick<typeof Admission, "appThread" | "settledEvent">;
type Fixture = Effect.Success<ReturnType<NativeSubagentHarness["makeHarness"]>>;

const nativeRun = (
  thread: OrchestrationV2AppThread,
  status: "running" | "completed",
): OrchestrationV2Run => ({
  id: RunId.make(`run:${thread.id}`),
  threadId: thread.id,
  ordinal: 1,
  providerInstanceId: thread.providerInstanceId,
  modelSelection: thread.modelSelection,
  providerThreadId: null,
  userMessageId: MessageId.make(`message:${thread.id}`),
  rootNodeId: null,
  activeAttemptId: null,
  status,
  requestedAt: DateTime.makeUnsafe(NOW),
  startedAt: DateTime.makeUnsafe(NOW),
  completedAt: status === "completed" ? DateTime.makeUnsafe(NOW) : null,
  checkpointId: null,
  contextHandoffId: null,
});

const nativeSubagent = (
  parent: OrchestrationV2AppThread,
  child: OrchestrationV2AppThread,
): OrchestrationV2Subagent => ({
  id: NodeId.make(`subagent:${child.id}`),
  threadId: parent.id,
  runId: null,
  parentNodeId: NodeId.make(`node:${parent.id}`),
  origin: "provider_native",
  createdBy: "agent",
  driver: ProviderDriverKind.make("codex"),
  providerInstanceId: child.providerInstanceId,
  providerThreadId: null,
  childThreadId: child.id,
  nativeTaskRef: null,
  prompt: "Keep working",
  title: null,
  model: null,
  status: "running",
  result: null,
  startedAt: DateTime.makeUnsafe(NOW),
  completedAt: null,
  updatedAt: DateTime.makeUnsafe(NOW),
});

// Provider-native children wait on their parent in the store's candidate query, so these cases
// feed the harness from a real projection store.
export function settlementNativeSubagentTests({
  makeHarness,
  makeThread,
  makeSnapshot,
  startHarness,
  appThread,
  settledEvent,
}: NativeSubagentHarness) {
  const storeBackedHarness = Effect.fn("storeBackedSettlementHarness")(function* (
    threads: ReadonlyArray<OrchestrationV2AppThread>,
    options: {
      readonly settings: ServerSettings;
      readonly currentThreads?: ReadonlyArray<OrchestrationV2AppThread>;
    },
  ) {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    for (const thread of threads) {
      yield* store.apply({
        type: "thread.created",
        id: EventId.make(`created:${thread.id}`),
        threadId: thread.id,
        occurredAt: thread.createdAt,
        payload: thread,
      });
    }
    const targetedReads = yield* Queue.unbounded<ThreadId>();
    let fixture: Fixture | undefined;
    fixture = yield* makeHarness({
      snapshot: makeSnapshot([]),
      settings: options.settings,
      ...(options.currentThreads === undefined ? {} : { currentThreads: options.currentThreads }),
      onCandidateRead: Effect.fn("storeBackedSettlementHarness.onCandidateRead")(function* (
        threadId?: ThreadId,
      ) {
        const rows = yield* store.getSettlementCandidates().pipe(Effect.orDie);
        if (fixture !== undefined)
          yield* Ref.set(
            fixture.snapshots,
            makeSnapshot(rows.map((row) => makeThread(row.id, row))),
          );
        if (threadId !== undefined) yield* Queue.offer(targetedReads, threadId);
      }),
      onDispatch: (command) =>
        store.getThread(command.threadId).pipe(
          Effect.flatMap((thread) =>
            store.apply(
              settledEvent({
                ...thread,
                settledOverride: "settled",
                settledAt: DateTime.makeUnsafe(NOW),
              }),
            ),
          ),
          Effect.orDie,
        ),
    });
    return { ...fixture, store, targetedReads };
  });

  it.effect(
    "drains provider-native children of a settled parent without PR lookups, one still working included, and retries one a person's run keeps busy",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse(NOW));
          const parent = appThread("native-parent", "settled");
          const child = (id: string, overrides: Partial<OrchestrationV2AppThread> = {}) => ({
            ...appThread(id, null),
            creationSource: "provider" as const,
            branch: "feature",
            lineage: {
              rootThreadId: parent.id,
              parentThreadId: parent.id,
              relationshipToParent: "subagent" as const,
            },
            ...overrides,
          });
          const empty = child("empty");
          const recent = child("recent");
          const working = child("working");
          const busy = child("busy");
          const fixture = yield* storeBackedHarness(
            [
              parent,
              empty,
              recent,
              working,
              busy,
              child("pinned", { pinnedAt: DateTime.makeUnsafe(NOW) }),
              child("opted-out", { autoSettleDisabledAt: DateTime.makeUnsafe(NOW) }),
            ],
            { settings: { ...DEFAULT_SERVER_SETTINGS, sidebarAutoSettleAfterDays: 2 } },
          );
          // A person's own message on a native child is an app run: finished on one, running on another.
          for (const payload of [nativeRun(recent, "completed"), nativeRun(busy, "running")]) {
            yield* fixture.store.apply({
              type: "run.created",
              id: EventId.make(`created:${payload.id}`),
              threadId: payload.threadId,
              occurredAt: DateTime.makeUnsafe(NOW),
              payload,
            });
          }
          // A native child at work has no app run: its parent records it as an active subagent.
          const task = nativeSubagent(parent, working);
          yield* fixture.store.apply({
            type: "subagent.updated",
            id: EventId.make(`subagent:${working.id}`),
            threadId: parent.id,
            nodeId: task.id,
            occurredAt: DateTime.makeUnsafe(NOW),
            payload: task,
          });
          yield* Effect.gen(function* () {
            const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
            yield* startHarness(service, fixture.activation, fixture.snapshotReads);
            const commands = yield* Ref.get(fixture.commands);
            // Known limit: the still-working child settles with its parent, as upstream.
            expect(commands.map((command) => command.threadId).toSorted()).toEqual(
              [empty.id, recent.id, working.id].toSorted(),
            );
            for (const command of commands) {
              expect(command.snapshotAt).toEqual(DateTime.makeUnsafe(NOW));
              expect(command.settledAt).toBeUndefined();
            }
            expect(
              (yield* fixture.store.getThreadRecords(parent.id, ["subagents"])).subagents.map(
                (row) => row.status,
              ),
            ).toEqual(["running"]);
            expect(yield* Ref.get(fixture.branchCalls)).toEqual([]);
            expect(yield* Ref.get(fixture.summaryCalls)).toEqual([]);
            const finished: OrchestrationV2DomainEvent = {
              type: "run.updated",
              id: EventId.make("busy:completed"),
              threadId: busy.id,
              occurredAt: DateTime.makeUnsafe(NOW),
              payload: nativeRun(busy, "completed"),
            };
            yield* fixture.store.apply(finished);
            yield* fixture.publishEvent(finished);
            expect(yield* Queue.take(fixture.targetedReads)).toBe(busy.id);
            yield* service.drain;
            expect(
              (yield* Ref.get(fixture.commands)).slice(3).map((command) => command.threadId),
            ).toEqual([busy.id]);
            expect(yield* Ref.get(fixture.branchCalls)).toEqual([]);
            expect(yield* Ref.get(fixture.summaryCalls)).toEqual([]);
          }).pipe(Effect.provide(fixture.layer));
        }).pipe(Effect.provide(projectionStoreSql)),
      ),
  );

  it.effect(
    "manual parent settlement drains its provider-native child with automatic settlement off, not its task lane",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse(NOW));
          const parent = appThread("manual-parent", null);
          const lineage = {
            rootThreadId: parent.id,
            parentThreadId: parent.id,
            relationshipToParent: "subagent" as const,
          };
          const child = {
            ...appThread("manual-child", null),
            creationSource: "provider" as const,
            branch: "feature",
            lineage,
          };
          const lane = {
            ...appThread("manual-lane", null),
            creationSource: "mcp" as const,
            lineage,
          };
          const marker = appThread("marker", "settled");
          const settledParent = {
            ...parent,
            settledOverride: "settled" as const,
            settledAt: DateTime.makeUnsafe(NOW),
          };
          const fixture = yield* storeBackedHarness([parent, child, lane, marker], {
            settings: {
              ...DEFAULT_SERVER_SETTINGS,
              sidebarAutoSettleAfterDays: null,
              sidebarAutoSettleOnMerge: false,
            },
            currentThreads: [settledParent, marker],
          });
          yield* Effect.gen(function* () {
            const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
            yield* startHarness(service, fixture.activation, fixture.snapshotReads);
            expect(yield* Ref.get(fixture.commands)).toEqual([]);
            const event = settledEvent(settledParent);
            yield* fixture.store.apply(event);
            yield* fixture.publishEvent(event);
            // Cleanup of the next event marks that the parent's event was handled.
            yield* fixture.publishEvent(settledEvent(marker));
            expect(yield* Queue.take(fixture.closedIdle)).toEqual({ threadId: parent.id });
            expect(yield* Queue.take(fixture.closedIdle)).toEqual({ threadId: marker.id });
            yield* service.drain;
            expect(yield* Ref.get(fixture.commands)).toEqual([
              expect.objectContaining({
                type: "thread.auto-settle",
                threadId: child.id,
                snapshotAt: child.updatedAt,
              }),
            ]);
            expect(yield* Ref.get(fixture.branchCalls)).toEqual([]);
            expect(yield* Ref.get(fixture.summaryCalls)).toEqual([]);
          }).pipe(Effect.provide(fixture.layer));
        }).pipe(Effect.provide(projectionStoreSql)),
      ),
  );
}
