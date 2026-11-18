/**
 * Failures and settings a live OpenCode 2 server cannot produce on demand,
 * driven through the real adapter and `@opencode/client` against a replayed
 * HTTP server. Frames reuse the shapes recorded against 2.0.18.
 */
import { type OrchestrationV2ProviderFailure } from "@goat/contracts";

import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  NodeId,
  ProviderTurnId,
  RunAttemptId,
  type ProviderReplayEntry,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import * as Stream from "effect/Stream";
import * as Exit from "effect/Exit";
import { TestClock } from "effect/testing";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";

import { OPENCODE_PROVIDER } from "@goat/provider-opencode/testing";

import { openCode2ReplayRuntime } from "./OpenCode2AdapterV2.testkit.ts";
import { makeProviderReplayGate, type ProviderReplayGate } from "@goat/provider-testing/replayGate";
import {
  PROMPT_ID,
  SESSION,
  bigPickle,
  event,
  noOpenRequests,
  opening,
  out,
  promptAccepted,
  providerThread,
  reply,
  replyData,
  openRequests,
  providerTurnId,
  reconnected,
  stopTimedOut,
  stopFirstTurn,
  turnItems,
  resumed,
  sessionInfo,
  shellAsk,
  turnInput,
} from "./OpenCode2AdapterV2.fixtures.testkit.ts";

it.layer(McpProviderSessions.layer)("OpenCode2 adapter", (it) => {
  const ASSISTANT = "msg_0eb735d5b001oAFVeY5jz3WD4Z";

  const rateLimited = {
    type: "provider.rate-limit",
    message: "Rate limit exceeded: free-models-per-min.",
    status: 429,
  };

  const retryScheduled = (attempt: number, delayMs: number) =>
    event("session.retry.scheduled", {
      sessionID: SESSION,
      assistantMessageID: ASSISTANT,
      attempt,
      at: 1 + delayMs,
      error: rateLimited,
    });

  const retrying = {
    class: "provider_error",
    message: rateLimited.message,
    code: rateLimited.type,
    retryable: true,
  } satisfies OrchestrationV2ProviderFailure;

  const firstRetry = { attempt: 1, maxAttempts: null, retryDelayMs: 2_000 };

  const errorRows = (collected: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
    collected.flatMap((event) =>
      event.type === "turn_item.updated" && event.turnItem.type === "error" ? [event.turnItem] : [],
    );

  const runRetryTurn = (entries: ReadonlyArray<ProviderReplayEntry>, gate?: ProviderReplayGate) =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed(
        [
          out("session.prompt", { sessionID: SESSION, text: "<any>" }),
          promptAccepted,
          event("session.execution.started", { sessionID: SESSION }),
          ...entries,
        ],
        gate === undefined ? undefined : { replayGate: gate },
      );
      const retryShown = yield* Deferred.make<void>();
      const collected = yield* runtime.events.pipe(
        Stream.tap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "error"
            ? Deferred.succeed(retryShown, undefined)
            : Effect.void,
        ),
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(turnInput(thread));
      if (gate !== undefined) {
        yield* Deferred.await(retryShown);
        yield* TestClock.adjust("5 seconds");
        gate.releaseAll();
      }
      return yield* Fiber.join(collected);
    });

  it.effect.each([
    {
      name: "recovers a provider retry at the provider's first output",
      after: [
        event("session.text.started", {
          sessionID: SESSION,
          assistantMessageID: ASSISTANT,
          ordinal: 0,
        }),
        event("session.text.ended", {
          sessionID: SESSION,
          assistantMessageID: ASSISTANT,
          ordinal: 0,
          text: "DONE",
        }),
        event("session.execution.succeeded", { sessionID: SESSION }),
      ],
      items: ["error:running", "error:completed", "assistant_message:completed"],
      ended: "completed" as const,
      title: "Provider recovered",
    },
    {
      name: "stops a provider retry when the user stops the turn",
      after: [event("session.execution.interrupted", { sessionID: SESSION, reason: "user" })],
      items: ["error:running", "error:interrupted"],
      ended: "interrupted" as const,
      title: "Provider retry stopped",
    },
  ])("$name", ({ after, items, ended, title }) =>
    Effect.gen(function* () {
      const seen = yield* runRetryTurn([retryScheduled(2, 2_000), ...after]);
      assert.deepEqual(turnItems(seen), items);
      const rows = errorRows(seen);
      assert.deepEqual(
        rows.map(({ id, title, failure, retry }) => ({ id, title, failure, retry })),
        [
          { id: rows[0]!.id, title: "Provider retry", failure: retrying, retry: firstRetry },
          { id: rows[0]!.id, title, failure: retrying, retry: firstRetry },
        ],
      );
      assert.deepInclude(seen.at(-1), { type: "turn.terminal", status: ended, failure: null });
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    { name: "restores retry pending at reconnect", pending: true, streamed: false },
    { name: "settles retry recovered during drop", pending: false, streamed: false },
  ])("$name", ({ pending, streamed }) =>
    Effect.gen(function* () {
      const gate = makeProviderReplayGate(["finish"]);
      const { runtime, thread } = yield* resumed(
        [
          out("session.prompt", { sessionID: SESSION, id: PROMPT_ID, text: "<any>" }),
          promptAccepted,
          event("session.execution.started", { sessionID: SESSION }),
          ...(pending && !streamed ? [] : [retryScheduled(2, 2_000)]),
          ...reconnected({ [SESSION]: { type: "running" } }, undefined, {
            id: ASSISTANT,
            finish: undefined,
            content: pending ? [] : [{ type: "text", text: "Recovered during the drop." }],
            ...(pending && !streamed
              ? { retry: { attempt: 2, at: 2_001, error: rateLimited } }
              : {}),
            ...(streamed ? { time: { created: 2, streamed: 3 } } : {}),
          }),
          ...openRequests([shellAsk.data]),
          event("session.execution.succeeded", { sessionID: SESSION }, "finish"),
        ],
        { supervised: true, replayGate: gate },
      );
      const events = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(turnInput(thread, bigPickle, "approval-required"));
      yield* Effect.promise(() => gate.waitForReached("finish"));
      gate.release("finish");
      const collected = yield* Fiber.join(events);
      // Reconciled requests follow backfill, before the terminal can settle the retry row.
      const reconciled = collected.findIndex((event) => event.type === "runtime_request.updated");
      assert.isAtLeast(reconciled, 0);
      const seen = collected.slice(0, reconciled);
      const rows = errorRows(seen);
      assert.deepEqual(
        rows.map(({ status, title }) => ({ status, title })),
        pending
          ? [{ status: "running", title: "Provider retry" }]
          : [
              { status: "running", title: "Provider retry" },
              { status: "completed", title: "Provider recovered" },
            ],
      );
      for (const row of rows) {
        assert.deepEqual(row.failure, retrying);
        assert.deepInclude(row.retry, { attempt: 1, maxAttempts: null });
        assert.equal(row.id, rows[0]!.id);
        assert.equal(row.ordinal, rows[0]!.ordinal);
        assert.deepEqual(row.startedAt, rows[0]!.startedAt);
      }
      if (!pending) {
        assert.isTrue(
          seen.some(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "assistant_message" &&
              event.turnItem.text === "Recovered during the drop.",
          ),
        );
      }
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    ["refuses a rollback while a timed-out Stop's run is still going", true],
  ] as const)("%s", ([, running]) =>
    Effect.gen(function* () {
      const prompt = `msg_t3_turn_${SESSION}:attempt:opencode2-adapter`;
      const { runtime, thread } = yield* resumed([
        ...stopTimedOut,
        out("session.active"),
        reply("session.active", { data: running ? { [SESSION]: { type: "running" } } : {} }),
        ...(running
          ? []
          : [
              out("message.list", "<any>"),
              reply("message.list", {
                data: [{ id: prompt, time: { created: 1 }, text: "hi", type: "user" }],
                cursor: {},
              }),
              out("session.revert.stage", {
                sessionID: SESSION,
                messageID: prompt,
                files: false,
              }),
              replyData("session.revert.stage", { messageID: prompt, files: [] }),
              out("session.revert.commit", { sessionID: SESSION }),
              reply("session.revert.commit", null),
              out("message.list", "<any>"),
              reply("message.list", { data: [], cursor: {} }),
            ]),
      ]);
      yield* stopFirstTurn(runtime, thread);
      const now = yield* DateTime.now;
      const first = {
        id: yield* providerTurnId,
        providerThreadId: thread.id,
        nodeId: NodeId.make("node:opencode2-adapter"),
        runAttemptId: RunAttemptId.make("attempt:opencode2-adapter"),
        nativeTurnRef: {
          driver: OPENCODE_PROVIDER,
          nativeId: prompt,
          strength: "weak" as const,
        },
        ordinal: 1,
        status: "interrupted" as const,
        startedAt: now,
        completedAt: now,
      };
      const rollback = yield* runtime
        .rollbackThread({
          providerThread: thread,
          target: {
            type: "thread_start",
            checkpointId: CheckpointId.make("checkpoint:start"),
            appRunOrdinal: 0,
          },
          providerThreadTurns: [first],
        })
        .pipe(Effect.exit);
      if (running) {
        assert.isTrue(Exit.isFailure(rollback));
        const error = Exit.isFailure(rollback) ? Cause.squash(rollback.cause) : undefined;
        assert.equal(
          (error as { _tag?: string } | undefined)?._tag,
          "ProviderAdapterProtocolError",
        );
      } else {
        assert.isTrue(Exit.isSuccess(rollback));
      }
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.effect.each([
    [
      "keeps the recorded turns before the target when rolling back a session not loaded yet",
      false,
    ],
  ] as const)("%s", ([, running]) =>
    Effect.gen(function* () {
      const first = `msg_t3_turn_${SESSION}:attempt:first`;
      const second = `msg_t3_turn_${SESSION}:attempt:second`;
      const runtime = yield* openCode2ReplayRuntime([
        ...opening,
        out("session.active"),
        reply("session.active", { data: running ? { [SESSION]: { type: "running" } } : {} }),
        ...(running
          ? []
          : [
              out("session.get", { sessionID: SESSION }),
              replyData("session.get", sessionInfo()),
              ...noOpenRequests,
              out("message.list", "<any>"),
              reply("message.list", {
                data: [
                  { id: second, time: { created: 2 }, text: "second", type: "user" },
                  { id: first, time: { created: 1 }, text: "first", type: "user" },
                ],
                cursor: {},
              }),
              out("session.revert.stage", {
                sessionID: SESSION,
                messageID: second,
                files: false,
              }),
              replyData("session.revert.stage", { messageID: second, files: [] }),
              out("session.revert.commit", { sessionID: SESSION }),
              reply("session.revert.commit", null),
              out("message.list", "<any>"),
              reply("message.list", {
                data: [{ id: first, time: { created: 1 }, text: "first", type: "user" }],
                cursor: {},
              }),
            ]),
      ]);
      const thread = providerThread(yield* DateTime.now);
      const now = yield* DateTime.now;
      const recorded = (key: string, ordinal: number, nativeId: string) => ({
        id: ProviderTurnId.make(`provider-turn:${key}`),
        providerThreadId: thread.id,
        nodeId: NodeId.make(`node:${key}`),
        runAttemptId: RunAttemptId.make(`attempt:${key}`),
        nativeTurnRef: { driver: OPENCODE_PROVIDER, nativeId, strength: "weak" as const },
        ordinal,
        status: "completed" as const,
        startedAt: now,
        completedAt: now,
      });
      const kept = recorded("first", 1, first);
      const rollback = yield* runtime
        .rollbackThread({
          providerThread: thread,
          target: {
            type: "provider_turn",
            checkpointId: CheckpointId.make("checkpoint:first"),
            appRunOrdinal: 1,
            providerTurn: kept,
          },
          providerThreadTurns: [kept, recorded("second", 2, second)],
        })
        .pipe(Effect.exit);
      if (running) {
        const error = Exit.isFailure(rollback) ? Cause.squash(rollback.cause) : undefined;
        assert.equal(
          (error as { _tag?: string } | undefined)?._tag,
          "ProviderAdapterProtocolError",
        );
      } else {
        assert.isTrue(Exit.isSuccess(rollback));
        assert.deepEqual(
          Exit.isSuccess(rollback) ? rollback.value.providerTurns.map((turn) => turn.id) : [],
          [kept.id],
        );
      }
    }).pipe(Effect.scoped),
  );
  it.effect("replaces a provider retry with the error that failed the turn", () =>
    Effect.gen(function* () {
      const step = {
        sessionID: SESSION,
        assistantMessageID: ASSISTANT,
        agent: "build",
        model: { providerID: "opencode", id: "big-pickle", variant: "default" },
        started: 1,
      };
      const gate = makeProviderReplayGate(["second retry"]);
      // OpenCode starts the step of each attempt that fails, so a step start is no recovery.
      const seen = yield* runRetryTurn(
        [
          event("session.step.started", step),
          retryScheduled(2, 2_000),
          event("session.step.started", step, "second retry"),
          retryScheduled(3, 4_000),
          event("session.step.started", step),
          event("session.step.failed", {
            sessionID: SESSION,
            assistantMessageID: ASSISTANT,
            error: rateLimited,
          }),
          event("session.execution.failed", { sessionID: SESSION, error: rateLimited }),
        ],
        gate,
      );
      const failed = { ...retrying, class: "usage_limit" as const, retryable: null };
      const lastRetry = { attempt: 2, maxAttempts: null, retryDelayMs: 4_000 };
      const rows = errorRows(seen);
      assert.deepEqual(
        rows.map(({ id, status, title, failure, retry }) => ({
          id,
          status,
          title,
          failure,
          retry,
        })),
        [
          {
            id: rows[0]!.id,
            status: "running",
            title: "Provider retry",
            failure: retrying,
            retry: firstRetry,
          },
          {
            id: rows[0]!.id,
            status: "running",
            title: "Provider retry",
            failure: retrying,
            retry: lastRetry,
          },
          {
            id: rows[0]!.id,
            status: "failed",
            title: "Usage limit reached",
            failure: failed,
            retry: lastRetry,
          },
        ],
      );
      const { startedAt, ordinal } = rows[0]!;
      assert.ok(startedAt);
      assert.deepEqual(
        rows.map((row) => ({ startedAt: row.startedAt, ordinal: row.ordinal })),
        rows.map(() => ({ startedAt, ordinal })),
      );
      assert.isAtLeast(
        DateTime.toEpochMillis(rows[2]!.updatedAt) - DateTime.toEpochMillis(startedAt),
        5_000,
      );
      assert.deepInclude(seen.at(-1), {
        type: "turn.terminal",
        status: "failed",
        failure: failed,
        failureItemOrdinal: ordinal,
        retry: lastRetry,
        retryStartedAt: startedAt,
      });
    }).pipe(Effect.scoped),
  );
});
