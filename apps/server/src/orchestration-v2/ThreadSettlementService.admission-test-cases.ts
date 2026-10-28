import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EventId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  TurnItemId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as SettlementAdmission from "./settlementAdmission.ts";
import { TestClock } from "effect/testing";
import * as ThreadSettlementService from "./ThreadSettlementService.ts";
import type * as Harness from "./ThreadSettlementService.test.ts";

const NOW = "2026-08-27T12:00:00.000Z";
const PROJECT_ID = ProjectId.make("settlement-project");

export const appThread = (
  id: string,
  settledOverride: OrchestrationV2AppThread["settledOverride"],
  worktreePath: string | null = null,
): OrchestrationV2AppThread => {
  const threadId = ThreadId.make(id);
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: PROJECT_ID,
    title: id,
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: DateTime.makeUnsafe(NOW),
    updatedAt: DateTime.makeUnsafe(NOW),
    archivedAt: null,
    settledOverride,
    settledAt: settledOverride === "settled" ? DateTime.makeUnsafe(NOW) : null,
    lastVisitedAt: null,
    deletedAt: null,
  };
};
export const settledEvent = (thread: OrchestrationV2AppThread): OrchestrationV2DomainEvent => ({
  type: "thread.settled",
  id: EventId.make(`event:settled:${thread.id}`),
  threadId: thread.id,
  occurredAt: DateTime.makeUnsafe(NOW),
  payload: thread,
});

export const terminalEvent = (threadId: ThreadId): OrchestrationV2DomainEvent => ({
  type: "run.background-work-cancelled",
  id: EventId.make(`ended:${threadId}`),
  threadId,
  occurredAt: DateTime.makeUnsafe(NOW),
  payload: { runId: RunId.make(`run:${threadId}`), restartCancelledBackgroundWork: [] },
});

export const shellMergeEvent = (threadId: ThreadId): OrchestrationV2DomainEvent => ({
  type: "turn-item.updated",
  id: EventId.make(`shell:${threadId}`),
  threadId,
  occurredAt: DateTime.makeUnsafe(NOW),
  payload: {
    id: TurnItemId.make(`shell:${threadId}`),
    threadId,
    runId: RunId.make(`run:${threadId}`),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    title: null,
    type: "command_execution",
    status: "completed",
    input: "gh pr merge 42",
    startedAt: DateTime.makeUnsafe(NOW),
    updatedAt: DateTime.makeUnsafe(NOW),
    completedAt: DateTime.makeUnsafe(NOW),
  },
});

const branchResult = (branch: string, refresh = false) => ({
  number: 42,
  title: "Pull request",
  url: "https://example.test/pr/42",
  baseRef: "main",
  headRef: branch,
  state: refresh ? ("merged" as const) : ("open" as const),
  mergedAt: refresh ? NOW : null,
  closedAt: null,
  updatedAt: NOW,
  repositoryKey: "example.test/owner/repository",
});

export function settlementAdmissionTests({
  makeHarness,
  makeThread,
  makeSnapshot,
  startHarness,
}: Pick<typeof Harness, "makeHarness" | "makeThread" | "makeSnapshot" | "startHarness">) {
  admissionWorkerTests();
  it.effect("forced reconciliation bypasses a shared cache repopulated by targeted work", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const entered = yield* Queue.unbounded<void>();
        const releaseTargets = yield* Deferred.make<void>();
        const fullEntered = yield* Deferred.make<void>();
        const releaseFull = yield* Deferred.make<void>();
        const sharedEntered = yield* Queue.unbounded<void>();
        const releaseRepeat = yield* Deferred.make<void>();
        const forceFull = yield* Ref.make(false);
        const sharedCalls = yield* Ref.make(0);
        const marker = appThread("cache-race-marker", "settled");
        const blockers = Array.from({ length: 8 }, (_, index) =>
          makeThread(`cache-blocker-${index}`, { branch: `blocker-${index}` }),
        );
        const target = makeThread("cache-target", { branch: "shared" });
        const overflow = makeThread("cache-overflow", { branch: "shared" });
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([]),
          currentThreads: [marker],
          settings: { ...DEFAULT_SERVER_SETTINGS, sidebarAutoSettleAfterDays: null },
          onCandidateRead: Effect.fn("settlementAdmissionTest.onCandidateRead")(function* (id) {
            if (id === undefined && (yield* Ref.get(forceFull))) {
              yield* Deferred.succeed(fullEntered, undefined);
              yield* Deferred.await(releaseFull);
            }
          }),
          branchPullRequest: Effect.fn("settlementAdmissionTest.branchPullRequest")(
            function* (input, options) {
              if (input.branch.startsWith("blocker-") && !options?.refresh) {
                yield* Queue.offer(entered, undefined);
                yield* Deferred.await(releaseTargets);
              }
              const beforeFullRead = !(yield* Deferred.isDone(releaseFull));
              const result = branchResult(input.branch, options?.refresh && !beforeFullRead);
              if (input.branch === "shared" && beforeFullRead) {
                const call = yield* Ref.updateAndGet(sharedCalls, (count) => count + 1);
                yield* Queue.offer(sharedEntered, undefined);
                if (call === 2) yield* Deferred.await(releaseRepeat);
              }
              return result;
            },
          ),
        });
        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          yield* Ref.set(fixture.snapshots, makeSnapshot([...blockers, target, overflow]));
          for (const thread of blockers) yield* fixture.publishEvent(terminalEvent(thread.id));
          for (let index = 0; index < 8; index++) yield* Queue.take(entered);
          yield* Ref.set(forceFull, true);
          yield* fixture.publishEvent(terminalEvent(target.id));
          for (let index = 0; index < 247; index++)
            yield* fixture.publishEvent(terminalEvent(ThreadId.make(`cache-queued-${index}`)));
          yield* fixture.publishEvent(terminalEvent(overflow.id));
          yield* Deferred.await(fullEntered);
          yield* Deferred.succeed(releaseTargets, undefined);
          yield* Queue.take(sharedEntered);
          yield* fixture.publishEvent(terminalEvent(target.id));
          // A second lookup for this key starts only after its first pass cached the open result.
          yield* Queue.take(sharedEntered);
          yield* Deferred.succeed(releaseFull, undefined);
          yield* Deferred.succeed(releaseRepeat, undefined);
          yield* service.drain;
          assert.include(
            (yield* Ref.get(fixture.commands)).map((command) => command.threadId),
            overflow.id,
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("forced reconciliation retains shell hints for ineligible background work", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const entered = yield* Queue.unbounded<void>();
        const release = yield* Deferred.make<void>();
        const marker = appThread("hint-retention-marker", "settled");
        const thread = makeThread("hint-pending", { branch: "feature" });
        const pending = {
          ...thread,
          pendingBackgroundTasks: [
            { taskId: "active", kind: "subagent" as const, description: "Review" },
          ],
        };
        const blockers = Array.from({ length: 8 }, (_, index) =>
          makeThread(`hint-blocker-${index}`, { branch: `blocker-${index}` }),
        );
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([thread]),
          currentThreads: [marker],
          settings: { ...DEFAULT_SERVER_SETTINGS, sidebarAutoSettleAfterDays: null },
          branchPullRequest: Effect.fn("settlementAdmissionTest.branchPullRequest")(
            function* (input, options) {
              if (input.branch.startsWith("blocker-")) {
                yield* Queue.offer(entered, undefined);
                yield* Deferred.await(release);
              }
              return branchResult(input.branch, options?.refresh);
            },
          ),
        });
        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          yield* Ref.set(fixture.snapshots, makeSnapshot([pending]));
          yield* fixture.publishEvent(shellMergeEvent(thread.id));
          yield* fixture.publishEvent(settledEvent(marker));
          yield* Queue.take(fixture.closedIdle);
          yield* service.drain;
          yield* Ref.set(fixture.snapshots, makeSnapshot([pending, ...blockers]));
          for (const blocker of blockers) yield* fixture.publishEvent(terminalEvent(blocker.id));
          for (let index = 0; index < 8; index++) yield* Queue.take(entered);
          for (let index = 0; index < 249; index++)
            yield* fixture.publishEvent(terminalEvent(ThreadId.make(`hint-queued-${index}`)));
          yield* fixture.publishEvent(settledEvent(marker));
          yield* Queue.take(fixture.closedIdle);
          yield* Deferred.succeed(release, undefined);
          yield* service.drain;
          yield* Ref.set(fixture.snapshots, makeSnapshot([thread]));
          yield* fixture.publishEvent(terminalEvent(thread.id));
          yield* fixture.publishEvent(settledEvent(marker));
          yield* Queue.take(fixture.closedIdle);
          yield* service.drain;
          assert.include(
            (yield* Ref.get(fixture.commands)).map((command) => command.threadId),
            thread.id,
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("retains more than 256 shell hints until background work ends", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const marker = appThread("hint-capacity-marker", "settled");
        const threads = Array.from({ length: 257 }, (_, index) =>
          makeThread(`hint-capacity-${index}`, {
            branch: `branch-${index}`,
            pendingBackgroundTasks: [{ taskId: "active", kind: "subagent", description: "Review" }],
          }),
        );
        const overflow = makeThread("hint-capacity-256", { branch: "branch-256" });
        const refreshes = yield* Ref.make<ReadonlyArray<boolean>>([]);
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([overflow]),
          currentThreads: [marker],
          settings: { ...DEFAULT_SERVER_SETTINGS, sidebarAutoSettleAfterDays: null },
          branchPullRequest: (input, options) =>
            Ref.update(refreshes, (values) => [...values, options?.refresh === true]).pipe(
              Effect.as(branchResult(input.branch, options?.refresh)),
            ),
        });
        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          assert.deepStrictEqual(yield* Ref.get(refreshes), [false]);
          yield* Ref.set(fixture.snapshots, makeSnapshot(threads));
          for (const thread of threads.slice(0, 256)) {
            yield* fixture.publishEvent(shellMergeEvent(thread.id));
            yield* fixture.publishEvent(settledEvent(marker));
            yield* Queue.take(fixture.closedIdle);
            yield* service.drain;
          }
          yield* Ref.set(fixture.candidateReads, []);
          yield* fixture.publishEvent(shellMergeEvent(ThreadId.make("hint-capacity-256")));
          yield* fixture.publishEvent(settledEvent(marker));
          yield* Queue.take(fixture.closedIdle);
          yield* service.drain;
          yield* TestClock.adjust("1 minute");
          yield* service.drain;
          assert.deepStrictEqual(yield* Ref.get(fixture.commands), []);
          yield* Ref.set(fixture.snapshots, makeSnapshot([overflow]));
          yield* fixture.publishEvent(terminalEvent(overflow.id));
          yield* fixture.publishEvent(settledEvent(marker));
          yield* Queue.take(fixture.closedIdle);
          yield* service.drain;
          assert.deepStrictEqual(yield* Ref.get(refreshes), [false, true]);
          assert.deepStrictEqual(
            (yield* Ref.get(fixture.commands)).map((command) => command.threadId),
            [overflow.id],
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect(
    "reconciles settlement overflow without retaining a targeted waiter for every thread",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse(NOW));
          const entered = yield* Queue.unbounded<void>();
          const release = yield* Deferred.make<void>();
          const marker = appThread("admission-marker", "settled");
          const recent = DateTime.makeUnsafe("2026-08-27T00:00:00.000Z");
          const threads = Array.from({ length: 272 }, (_, index) =>
            makeThread(`admission-${index}`, {
              branch: `branch-${index}`,
              latestUserMessageAt: recent,
            }),
          );
          const fixture = yield* makeHarness({
            snapshot: makeSnapshot([]),
            currentThreads: [marker],
            settings: {
              ...DEFAULT_SERVER_SETTINGS,
              sidebarAutoSettleAfterDays: null,
              sidebarAutoSettleOnMerge: true,
            },
            branchPullRequest: () =>
              Queue.offer(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as({
                  number: 42,
                  title: "Merged",
                  url: "https://example.test/pr/42",
                  baseRef: "main",
                  headRef: "feature",
                  state: "merged" as const,
                  mergedAt: NOW,
                  closedAt: null,
                  repositoryKey: "example.test/owner/repository",
                  updatedAt: NOW,
                }),
              ),
          });
          const terminalEvent = (threadId: ThreadId): OrchestrationV2DomainEvent => ({
            type: "run.background-work-cancelled",
            id: EventId.make(`admission:${threadId}`),
            threadId,
            occurredAt: recent,
            payload: { runId: RunId.make(`run:${threadId}`), restartCancelledBackgroundWork: [] },
          });
          yield* Effect.gen(function* () {
            const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
            yield* startHarness(service, fixture.activation, fixture.snapshotReads);
            yield* Ref.set(fixture.candidateReads, []);
            yield* Ref.set(fixture.snapshots, makeSnapshot(threads));
            for (const thread of threads.slice(0, 8))
              yield* fixture.publishEvent(terminalEvent(thread.id));
            for (let index = 0; index < 8; index++) yield* Queue.take(entered);
            for (const thread of threads.slice(8))
              yield* fixture.publishEvent(terminalEvent(thread.id));
            yield* fixture.publishEvent(settledEvent(marker));
            assert.deepStrictEqual(yield* Queue.take(fixture.closedIdle), { threadId: marker.id });
            yield* Deferred.succeed(release, undefined);
            yield* service.drain;
            const reads = yield* Ref.get(fixture.candidateReads);
            assert.isTrue(reads.includes(undefined));
            assert.isAtMost(reads.filter((id) => id !== undefined).length, 256);
            assert.deepStrictEqual(
              [
                ...new Set((yield* Ref.get(fixture.commands)).map((command) => command.threadId)),
              ].sort(),
              threads.map((thread) => thread.id).sort(),
            );
          }).pipe(Effect.provide(fixture.layer));
        }),
      ),
  );
  it.effect(
    "refreshes overflow after an active full snapshot and keeps re-engaged threads active",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse(NOW));
          const entered = yield* Queue.unbounded<void>();
          const release = yield* Deferred.make<void>();
          const fresh = yield* Ref.make<ReadonlyArray<string>>([]);
          const marker = appThread("overflow-marker", "settled");
          const threads = Array.from({ length: 272 }, (_, index) =>
            makeThread(`late-${index}`, { branch: `branch-${index}` }),
          );
          const fixture = yield* makeHarness({
            snapshot: makeSnapshot([]),
            currentThreads: [marker],
            settings: { ...DEFAULT_SERVER_SETTINGS, sidebarAutoSettleAfterDays: null },
            branchPullRequest: Effect.fn("settlementAdmissionTest.branchPullRequest")(
              function* (input, options) {
                if (options?.refresh)
                  yield* Ref.update(fresh, (branches) => [...branches, input.branch]);
                yield* Queue.offer(entered, undefined);
                yield* Deferred.await(release);
                return {
                  number: 42,
                  title: "Pull request",
                  url: "https://example.test/pr/42",
                  baseRef: "main",
                  headRef: input.branch,
                  state: options?.refresh ? ("merged" as const) : ("open" as const),
                  mergedAt: options?.refresh ? NOW : null,
                  closedAt: null,
                  updatedAt: NOW,
                  repositoryKey: "example.test/owner/repository",
                };
              },
            ),
          });
          yield* Effect.gen(function* () {
            const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
            yield* startHarness(service, fixture.activation, fixture.snapshotReads);
            yield* Ref.set(fixture.candidateReads, []);
            yield* Ref.set(fixture.snapshots, makeSnapshot(threads.slice(0, 8)));
            yield* fixture.updateSettings({ sidebarAutoSettleAfterDays: 20 });
            for (let index = 0; index < 8; index++) yield* Queue.take(entered);
            const reengagedId = ThreadId.make("late-270");
            yield* Ref.set(
              fixture.snapshots,
              makeSnapshot(
                threads.map((thread) =>
                  thread.id === reengagedId
                    ? {
                        ...thread,
                        pendingBackgroundTasks: [
                          { taskId: "active", kind: "subagent", description: "Review" },
                        ],
                      }
                    : thread,
                ),
              ),
            );
            for (const thread of threads) {
              yield* fixture.publishEvent({
                type: "run.background-work-cancelled",
                id: EventId.make(`late:${thread.id}`),
                threadId: thread.id,
                occurredAt: DateTime.makeUnsafe(NOW),
                payload: {
                  runId: RunId.make(`run:${thread.id}`),
                  restartCancelledBackgroundWork: [],
                },
              });
            }
            yield* fixture.publishEvent({
              type: "turn-item.updated",
              id: EventId.make("overflow-shell-merge"),
              threadId: ThreadId.make("late-271"),
              occurredAt: DateTime.makeUnsafe(NOW),
              payload: {
                id: TurnItemId.make("overflow-shell-item"),
                threadId: ThreadId.make("late-271"),
                runId: RunId.make("overflow-shell-run"),
                nodeId: null,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 1,
                title: null,
                type: "command_execution",
                status: "completed",
                input: "gh pr merge 42",
                startedAt: DateTime.makeUnsafe(NOW),
                updatedAt: DateTime.makeUnsafe(NOW),
                completedAt: DateTime.makeUnsafe(NOW),
              },
            });
            yield* fixture.publishEvent(settledEvent(marker));
            yield* Queue.take(fixture.closedIdle);
            yield* Deferred.succeed(release, undefined);
            yield* service.drain;
            const reads = yield* Ref.get(fixture.candidateReads);
            assert.strictEqual(reads.filter((id) => id === undefined).length, 2);
            assert.isAtMost(reads.filter((id) => id !== undefined).length, 256);
            assert.isTrue((yield* Ref.get(fresh)).includes("branch-271"));
            assert.deepStrictEqual(
              [
                ...new Set((yield* Ref.get(fixture.commands)).map((command) => command.threadId)),
              ].sort(),
              threads
                .filter((thread) => thread.id !== reengagedId)
                .map((thread) => thread.id)
                .sort(),
            );
            assert.strictEqual(yield* Queue.size(fixture.scriptRuns), 0);
          }).pipe(Effect.provide(fixture.layer));
        }),
      ),
  );
  it.effect("keeps a shell merge refresh until background work can settle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const thread = makeThread("shell-pending", { branch: "feature" });
        const marker = appThread("shell-marker", "settled");
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([thread]),
          currentThreads: [marker],
          settings: { ...DEFAULT_SERVER_SETTINGS, sidebarAutoSettleAfterDays: null },
          branchPullRequest: (_input, options) =>
            Effect.succeed({
              number: 42,
              title: "Pull request",
              url: "https://example.test/pr/42",
              baseRef: "main",
              headRef: "feature",
              state: options?.refresh ? ("merged" as const) : ("open" as const),
              mergedAt: options?.refresh ? NOW : null,
              closedAt: null,
              updatedAt: NOW,
              repositoryKey: "example.test/owner/repository",
            }),
        });
        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          yield* Ref.set(
            fixture.snapshots,
            makeSnapshot([
              {
                ...thread,
                pendingBackgroundTasks: [
                  { taskId: "active", kind: "subagent", description: "Review" },
                ],
              },
            ]),
          );
          yield* fixture.publishEvent({
            type: "turn-item.updated",
            id: EventId.make("pending-shell"),
            threadId: thread.id,
            occurredAt: DateTime.makeUnsafe(NOW),
            payload: {
              id: TurnItemId.make("pending-shell"),
              threadId: thread.id,
              runId: RunId.make("pending-run"),
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1,
              title: null,
              type: "command_execution",
              status: "completed",
              input: "gh pr merge 42",
              startedAt: DateTime.makeUnsafe(NOW),
              completedAt: DateTime.makeUnsafe(NOW),
              updatedAt: DateTime.makeUnsafe(NOW),
            },
          });
          yield* fixture.publishEvent(settledEvent(marker));
          yield* Queue.take(fixture.closedIdle);
          yield* service.drain;
          assert.deepStrictEqual(yield* Ref.get(fixture.commands), []);
          yield* Ref.set(fixture.snapshots, makeSnapshot([thread]));
          yield* fixture.publishEvent({
            type: "run.background-work-cancelled",
            id: EventId.make("pending-ended"),
            threadId: thread.id,
            occurredAt: DateTime.makeUnsafe(NOW),
            payload: { runId: RunId.make("pending-run"), restartCancelledBackgroundWork: [] },
          });
          yield* fixture.publishEvent(settledEvent(marker));
          yield* Queue.take(fixture.closedIdle);
          yield* service.drain;
          assert.deepStrictEqual(
            (yield* Ref.get(fixture.commands)).map((command) => command.threadId),
            [thread.id],
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );
}

function admissionWorkerTests() {
  it.effect("bounds reserved settlement keys and gives a hot rerun its FIFO turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Queue.unbounded<number>();
        const release = yield* Deferred.make<void>();
        const seen = yield* Ref.make<ReadonlyArray<number>>([]);
        const worker = yield* SettlementAdmission.make({
          targeted: (key: number) =>
            Ref.update(seen, (keys) => [...keys, key]).pipe(
              Effect.andThen(Queue.offer(entered, key)),
              Effect.andThen(Deferred.await(release)),
            ),
          full: () => Effect.void,
        });
        for (let key = 0; key < 8; key++) yield* worker.enqueue(key);
        for (let index = 0; index < 8; index++) yield* Queue.take(entered);
        for (let key = 8; key < 256; key++) yield* worker.enqueue(key);
        for (let index = 0; index < 100; index++) yield* worker.enqueue(0, true);
        for (let key = 256; key < 512; key++) yield* worker.enqueue(key);
        const snapshot = yield* worker.snapshot;
        assert.strictEqual(snapshot.reserved, 256);
        assert.strictEqual(snapshot.running, 8);
        assert.strictEqual(snapshot.queued, 248);
        assert.strictEqual(snapshot.rerun, 1);
        yield* Deferred.succeed(release, undefined);
        yield* worker.drain;
        const keys = yield* Ref.get(seen);
        assert.strictEqual(keys.length, 257);
        assert.strictEqual(keys.at(-1), 0);
        assert.strictEqual((yield* worker.snapshot).reserved, 0);
      }),
    ),
  );

  it.effect("coalesces full wakes on both sides of a pass and drains both lanes together", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Queue.unbounded<number>();
        const firstRelease = yield* Deferred.make<void>();
        const secondRelease = yield* Deferred.make<void>();
        const thirdRelease = yield* Deferred.make<void>();
        const calls = yield* Ref.make(0);
        const targetEntered = yield* Deferred.make<void>();
        const releaseTarget = yield* Deferred.make<void>();
        const drained = yield* Deferred.make<void>();
        const worker = yield* SettlementAdmission.make({
          targeted: (_key: string) =>
            Deferred.succeed(targetEntered, undefined).pipe(
              Effect.andThen(Deferred.await(releaseTarget)),
            ),
          full: Effect.fn("settlementAdmissionTest.full")(function* () {
            const call = yield* Ref.updateAndGet(calls, (value) => value + 1);
            yield* Queue.offer(entered, call);
            yield* Deferred.await(
              call === 1 ? firstRelease : call === 2 ? secondRelease : thirdRelease,
            );
          }),
        });
        yield* worker.enqueueFull;
        assert.strictEqual(yield* Queue.take(entered), 1);
        for (let index = 0; index < 100; index++) yield* worker.enqueueFull;
        const drain = yield* worker.drain.pipe(
          Effect.andThen(Deferred.succeed(drained, undefined)),
          Effect.forkScoped,
        );
        yield* Deferred.succeed(firstRelease, undefined);
        assert.strictEqual(yield* Queue.take(entered), 2);
        assert.isFalse(yield* Deferred.isDone(drained));
        yield* worker.enqueueFull;
        yield* Deferred.succeed(secondRelease, undefined);
        assert.strictEqual(yield* Queue.take(entered), 3);
        yield* worker.enqueue("last-target");
        yield* Deferred.await(targetEntered);
        yield* Deferred.succeed(thirdRelease, undefined);
        yield* worker.drainFull;
        assert.isFalse(yield* Deferred.isDone(drained));
        yield* Deferred.succeed(releaseTarget, undefined);
        yield* Fiber.join(drain);
        assert.strictEqual(yield* Ref.get(calls), 3);
        assert.strictEqual((yield* worker.snapshot).reserved, 0);
      }),
    ),
  );

  it.effect("releases settlement reservations after a typed failure or defect", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const seen = yield* Ref.make<ReadonlyArray<string>>([]);
        const worker = yield* SettlementAdmission.make({
          targeted: (key: string) =>
            key === "failure"
              ? Effect.fail("lookup failed")
              : key === "defect"
                ? Effect.die("lookup defect")
                : Ref.update(seen, (keys) => [...keys, key]),
          full: () => Effect.fail("full failed"),
        });
        yield* worker.enqueue("failure");
        yield* worker.enqueue("defect");
        yield* worker.enqueueFull;
        yield* worker.drain;
        assert.strictEqual((yield* worker.snapshot).reserved, 0);
        yield* worker.enqueue("later");
        yield* worker.drain;
        assert.deepStrictEqual(yield* Ref.get(seen), ["later"]);
      }),
    ),
  );

  it.effect("interrupts settlement workers and releases queued keys when their scope closes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const entered = yield* Queue.unbounded<void>();
        const cancelled = yield* Ref.make(0);
        const release = yield* Deferred.make<void>();
        const work = Queue.offer(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.ensuring(Ref.update(cancelled, (value) => value + 1)),
        );
        const worker = yield* SettlementAdmission.make({
          targeted: (_key: number) => work,
          full: () => work,
        }).pipe(Effect.provideService(Scope.Scope, scope));
        for (let key = 0; key < 256; key++) yield* worker.enqueue(key);
        yield* worker.enqueue(256);
        for (let index = 0; index < 9; index++) yield* Queue.take(entered);
        yield* Scope.close(scope, Exit.void);
        yield* worker.drain;
        assert.strictEqual(yield* Ref.get(cancelled), 9);
        const snapshot = yield* worker.snapshot;
        assert.strictEqual(snapshot.reserved, 0);
        assert.strictEqual(snapshot.full, "idle");
        assert.isTrue(snapshot.closed);
        assert.isTrue(Exit.isFailure(yield* Effect.exit(worker.enqueue(257))));
      }),
    ),
  );
}
