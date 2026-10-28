import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EventId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
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

export function settlementAdmissionTests({
  makeHarness,
  makeThread,
  makeSnapshot,
  startHarness,
}: Pick<typeof Harness, "makeHarness" | "makeThread" | "makeSnapshot" | "startHarness">) {
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
}
