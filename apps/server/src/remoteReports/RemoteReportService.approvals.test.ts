// @effect-diagnostics nodeBuiltinImport:off - the origin side hashes its read key with node:crypto.
import * as NodeCrypto from "node:crypto";

import { expect, it } from "@effect/vitest";
import {
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
} from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import migration from "../persistence/Migrations/071_RemoteReports.ts";
import dispatchMigration from "../persistence/Migrations/072_RemoteDispatches.ts";
import threadRunResultsMigration from "../persistence/Migrations/075_ThreadRunResults.ts";
import relayMigration from "../persistence/Migrations/076_RemoteReportRelay.ts";
import observedChecksMigration from "../persistence/Migrations/093_ThreadRunObservedChecks.ts";
import fencesMigration from "../persistence/Migrations/107_RemoteReportFences.ts";
import * as RemoteReportService from "./RemoteReportService.ts";

const threadId = ThreadId.make("remote-thread");
const childId = ThreadId.make("remote-child");
const runA = RunId.make("run-a");
const readKey = "1".repeat(64);
const binding = {
  correlationId: "correlation",
  originLabel: "origin laptop",
  originThreadId: ThreadId.make("origin-thread"),
  readKeyHash: NodeCrypto.createHash("sha256").update(readKey, "utf8").digest("hex"),
};
const emptyObservation = { pullRequests: [], needsYou: [] };
const request = (id: string, at: string): OrchestrationV2RuntimeRequest =>
  ({
    id: RuntimeRequestId.make(id),
    kind: "command",
    status: "pending",
    createdAt: DateTime.makeUnsafe(at),
  }) as OrchestrationV2RuntimeRequest;

const subagent = (
  childThreadId: ThreadId | null,
  extra: Partial<OrchestrationV2Subagent> = {},
): OrchestrationV2Subagent =>
  ({
    childThreadId,
    status: "running",
    origin: "app_owned",
    ...extra,
  }) as OrchestrationV2Subagent;

const stored = (thread: ThreadId, sequence: number) =>
  ({
    sequence,
    commandId: null,
    event: { threadId: thread, type: "runtime-request.updated" },
  }) as unknown as OrchestrationV2StoredEvent;

const setup = Effect.gen(function* () {
  yield* migration;
  yield* dispatchMigration;
  yield* threadRunResultsMigration;
  yield* observedChecksMigration;
  yield* relayMigration;
  yield* fencesMigration;
  const childEvents = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
  const childStreamOpened = yield* Deferred.make<void>();
  const childEventSeen = yield* Deferred.make<string>();
  const parentEvents = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
  const records = new Map<
    string,
    {
      runtimeRequests: OrchestrationV2RuntimeRequest[];
      subagents: OrchestrationV2Subagent[];
    }
  >();
  records.set(threadId, { runtimeRequests: [], subagents: [] });
  const subscriptions: Array<
    Parameters<Orchestrator.OrchestratorV2["Service"]["streamStoredEventsFrom"]>[0]
  > = [];
  const fake = Layer.mock(Orchestrator.OrchestratorV2)({
    getThreadShell: () =>
      Effect.succeed({
        id: threadId,
        activeRunId: runA,
        latestRunId: runA,
        deletedAt: null,
        pullRequests: [],
      } as unknown as OrchestrationV2ThreadShell),
    getThreadEventSequence: () => Effect.succeed(4),
    getThreadRecords: (id, fields) =>
      Effect.sync(() => {
        const row = records.get(id) ?? { runtimeRequests: [], subagents: [] };
        const asked = fields as ReadonlyArray<string>;
        return {
          thread: { id, deletedAt: null },
          runs: [{ id: runA, threadId, status: "running", ordinal: 1 } as OrchestrationV2Run],
          turnItems: [],
          runtimeRequests: asked.includes("runtimeRequests") ? row.runtimeRequests : [],
          subagents: asked.includes("subagents") ? row.subagents : [],
        } as unknown as OrchestrationV2ThreadProjection;
      }),
    delegatedTaskResultPending: () => Effect.succeed(false),
    streamStoredEventsFrom: (input) => {
      subscriptions.push(input);
      // A stream that never emits still has to park on a queue. Stream.never stalls
      // the merged channel, so the child subscription would never be pulled.
      if (input?.threadId === undefined) {
        return Stream.fromEffect(Deferred.succeed(childStreamOpened, undefined)).pipe(
          Stream.drain,
          Stream.concat(
            Stream.fromQueue(childEvents).pipe(
              Stream.tap((event) =>
                Deferred.succeed(childEventSeen, event.event.threadId).pipe(Effect.ignore),
              ),
            ),
          ),
        );
      }
      return Stream.fromQueue(parentEvents);
    },
  });
  const context = yield* Layer.build(RemoteReportService.layer.pipe(Layer.provide(fake)));
  const service = Context.get(context, RemoteReportService.RemoteReportService);
  yield* service.bind(threadId, binding);
  return { service, records, subscriptions, childEvents, childStreamOpened, childEventSeen };
});

const withSetup = <A, E, R>(
  body: (fixture: Effect.Success<typeof setup>) => Effect.Effect<A, E, R>,
) =>
  setup.pipe(
    Effect.flatMap(body),
    Effect.scoped,
    Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
  );

it.effect("names the thread on this machine for a worker approval and a local subagent", () =>
  withSetup(({ service, records, subscriptions }) =>
    Effect.gen(function* () {
      records.set(threadId, {
        runtimeRequests: [request("approval:worker", "2026-10-12T00:01:00.000Z")],
        subagents: [
          subagent(childId),
          subagent(null),
          subagent(null, {
            remote: { host: "other", threadId: null, correlationId: "elsewhere" },
          }),
        ],
      });
      records.set(childId, {
        runtimeRequests: [request("approval:child", "2026-10-12T00:02:00.000Z")],
        subagents: [],
      });
      const result = yield* service.wait({
        correlationId: binding.correlationId,
        readKey,
        afterSequence: 0,
        watchRunId: runA,
        knownRun: null,
        timeoutMs: 0,
      });
      const needs = result.observedRun?.observation?.needsYou ?? [];
      expect(needs.map((need) => need.approval)).toEqual([
        { requestId: "approval:worker", threadId },
        { requestId: "approval:child", threadId: childId },
      ]);
      expect(subscriptions.some((input) => input?.threadId === undefined)).toBe(false);
    }),
  ),
);

it.effect("wakes a waiting report when a live local subagent's approval opens", () =>
  withSetup(({ service, records, childEvents, childStreamOpened, childEventSeen }) =>
    Effect.gen(function* () {
      records.set(threadId, {
        runtimeRequests: [],
        subagents: [subagent(childId)],
      });
      records.set(childId, { runtimeRequests: [], subagents: [] });
      const fiber = yield* service
        .wait({
          correlationId: binding.correlationId,
          readKey,
          afterSequence: 0,
          watchRunId: runA,
          knownRun: {
            runId: runA,
            status: "running",
            pendingRequestIds: [],
            observation: emptyObservation,
          },
          timeoutMs: 10_000,
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(childStreamOpened);
      records.get(childId)!.runtimeRequests = [
        request("approval:child", "2026-10-12T00:03:00.000Z"),
      ];
      yield* Queue.offer(childEvents, stored(ThreadId.make("unrelated"), 5));
      expect(yield* Deferred.await(childEventSeen)).toBe("unrelated");
      for (let step = 0; step < 40; step++) yield* Effect.yieldNow;
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* Queue.offer(childEvents, stored(childId, 6));
      const result = yield* Fiber.join(fiber);
      expect(result.observedRun?.observation?.needsYou.map((need) => need.approval)).toEqual([
        { requestId: "approval:child", threadId: childId },
      ]);
    }),
  ),
);
