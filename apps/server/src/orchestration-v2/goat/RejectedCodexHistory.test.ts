import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  NodeId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
} from "@goat/contracts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import type * as ProjectionStore from "../ProjectionStore.ts";
import { pendingBackgroundFailure, rejectedCodexHistory } from "./RejectedCodexHistory.ts";

it.effect("recovers only a rejected accepted turn belonging to the current native thread", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread");
    const providerThread = {
      id: ProviderThreadId.make("provider-thread"),
      nativeThreadRef: { nativeId: "native" },
    } as OrchestrationV2ProviderThread;
    const run = { id: RunId.make("current"), ordinal: 2 } as OrchestrationV2Run;
    const attemptId = RunAttemptId.make("attempt");
    const rootNodeId = NodeId.make("root");
    const projection = {
      thread: { id: threadId },
      runs: [
        {
          id: RunId.make("previous"),
          ordinal: 1,
          status: "failed",
          providerThreadId: providerThread.id,
          activeAttemptId: attemptId,
          rootNodeId,
        },
      ],
      attempts: [{ id: attemptId, nativeThreadId: "native" }],
      providerTurns: [{ runAttemptId: attemptId }],
      contextHandoffs: [],
    } as unknown as OrchestrationV2ThreadProjection;
    const store = {
      getTurnStartHistory: () =>
        Effect.succeed([
          {
            type: "error",
            nodeId: rootNodeId,
            failure: { code: "invalid_encrypted_content", message: "invalid" },
          },
        ]),
    } as unknown as ProjectionStore.ProjectionStoreV2["Service"];
    const check = (candidate = projection, driver = "codex") =>
      rejectedCodexHistory({ driver, projection: candidate, run, providerThread, store });
    assert.isTrue(yield* check());
    assert.isFalse(yield* check(projection, "claudeAgent"));
    const { nativeThreadId: _nativeThreadId, ...legacyAttempt } = projection.attempts[0]!;
    assert.isFalse(
      yield* check({
        ...projection,
        attempts: [{ ...projection.attempts[0]!, nativeThreadId: "other" }],
      }),
    );
    assert.isFalse(
      yield* check({ ...projection, runs: [{ ...projection.runs[0]!, status: "completed" }] }),
    );
    assert.isFalse(yield* check({ ...projection, providerTurns: [] }));
    assert.isFalse(
      yield* check({
        ...projection,
        attempts: [legacyAttempt],
        contextHandoffs: [
          {
            toProviderThreadId: providerThread.id,
            strategy: "full_thread_summary",
            delivery: { nativeThreadId: "native" },
            coveredRunOrdinals: { from: 1, to: 1 },
          } as never,
        ],
      }),
    );
  }),
);

it.effect("refuses a fresh session while the old thread has background work", () =>
  Effect.gen(function* () {
    const providerThread = {
      id: ProviderThreadId.make("provider-thread"),
    } as OrchestrationV2ProviderThread;
    const session = {
      driver: ProviderDriverKind.make("codex"),
      hasPendingBackgroundWorkForThread: () => Effect.succeed(true),
    } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime;
    const failure = yield* pendingBackgroundFailure(session, providerThread, {
      id: RunId.make("run"),
      threadId: ThreadId.make("thread"),
    } as OrchestrationV2Run);
    assert.equal(failure?._tag, "ProviderAdapterTurnStartError");
  }),
);
