import type {
  OrchestrationV2ProviderThread,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  ThreadId,
} from "@goat/contracts";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import { classifyCodexManagedError } from "../../provider/CodexManagedErrors.ts";
import type * as ProjectionStore from "../ProjectionStore.ts";
import { ContextHandoffBackgroundWorkError } from "@goat/provider-core/server/failure";

export const rejectedCodexHistory = Effect.fn("ProviderTurnStart.rejectedCodexHistory")(
  function* (input: {
    driver: string;
    projection: Pick<
      OrchestrationV2ThreadProjection,
      "thread" | "runs" | "attempts" | "providerTurns" | "contextHandoffs"
    >;
    run: OrchestrationV2Run;
    providerThread: OrchestrationV2ProviderThread;
    store: ProjectionStore.ProjectionStoreV2["Service"];
  }) {
    if (input.driver !== "codex") return false;
    const { projection, run, providerThread } = input;
    const accepted = new Set(projection.providerTurns.map((turn) => turn.runAttemptId));
    const previous = projection.runs.findLast(
      (source) =>
        source.providerThreadId === providerThread.id &&
        source.ordinal < run.ordinal &&
        source.activeAttemptId !== null &&
        accepted.has(source.activeAttemptId),
    );
    if (previous === undefined || !["failed", "interrupted", "cancelled"].includes(previous.status))
      return false;
    const attempt = projection.attempts.find((source) => source.id === previous.activeAttemptId);
    if (attempt === undefined) return false;
    if (attempt.nativeThreadId !== undefined) {
      if (attempt.nativeThreadId !== providerThread.nativeThreadRef?.nativeId) return false;
    } else if (
      projection.contextHandoffs.some(
        (handoff) =>
          handoff.toProviderThreadId === providerThread.id &&
          handoff.strategy === "full_thread_summary" &&
          handoff.delivery?.nativeThreadId === providerThread.nativeThreadRef?.nativeId &&
          handoff.coveredRunOrdinals.to >= previous.ordinal,
      )
    )
      return false;
    return (yield* input.store.getTurnStartHistory(projection.thread.id, [previous.id])).some(
      (item) =>
        item.type === "error" &&
        item.nodeId === previous.rootNodeId &&
        (item.failure.code === "invalid_encrypted_content" ||
          classifyCodexManagedError(item.failure.message)?.code === "invalid_encrypted_content"),
    );
  },
);

export const pendingBackgroundFailure = Effect.fn("ProviderTurnStart.pendingBackgroundFailure")(
  function* (
    session: ProviderAdapter.ProviderAdapterV2SessionRuntime,
    providerThread: OrchestrationV2ProviderThread,
    threadId: ThreadId,
    run: OrchestrationV2Run,
  ) {
    const pending = yield* (
      session.hasPendingBackgroundWorkForThread?.(providerThread, { includeSubagents: true }) ??
        session.hasPendingBackgroundWork ??
        Effect.succeed(false)
    );
    return pending
      ? new ProviderAdapter.ProviderAdapterTurnStartError({
          driver: session.driver,
          threadId,
          providerThreadId: providerThread.id,
          runId: run.id,
          cause: new ContextHandoffBackgroundWorkError(),
        })
      : undefined;
  },
);
