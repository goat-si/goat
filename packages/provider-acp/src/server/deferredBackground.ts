import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import type { AcpToolCallState } from "./runtimeModel.ts";
import * as Ref from "effect/Ref";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import type { AcpAdapterV2SubagentUpdate } from "./adapterFlavor.ts";
import type { ActiveAcpTurn } from "./adapter.ts";
import type { AcpAdapterV2Flavor } from "./adapterFlavor.ts";
import { acpSubagentStatusBlocksTurnSettlement } from "./acpSubagentStatus.ts";
import { toolStatus } from "./subagentToolProjection.ts";

export function hasAcpDeferredBackgroundWork(
  context: ActiveAcpTurn,
  flavor: AcpAdapterV2Flavor,
  requestCount: number,
  ignoreTool?: (tool: AcpToolCallState) => boolean,
): boolean {
  if (flavor.toolOutlivesPrompt !== undefined) {
    for (const tool of context.tools.values()) {
      if (ignoreTool?.(tool) === true) continue;
      if (toolStatus(tool.status) === "running" && flavor.toolOutlivesPrompt(tool)) return true;
    }
  }
  if (flavor.wakeOnDetachedRequest && requestCount > 0) return true;
  if (context.awaitingBackgroundHydration.size > 0 || context.pendingInjectedReport.size > 0)
    return true;
  for (const [taskId, toolCallId] of context.toolCallIdsByBackgroundTaskId) {
    if (context.persistentBackgroundTaskIds.has(taskId)) continue;
    const tool = context.tools.get(toolCallId);
    if (tool === undefined) continue;
    const status = toolStatus(tool.status);
    if (status === "pending" || status === "running") return true;
  }
  if (
    flavor.subagentsIdleOnTurnCompletion === true &&
    flavor.subagentsOutlivingPrompt === undefined
  )
    return false;
  return [...context.subagents.values()].some((subagent) =>
    acpSubagentStatusBlocksTurnSettlement(subagent.task.status),
  );
}

// Grok summaries can trail hydrated tools by over two seconds.
export const acpTiming = {
  ACP_DEFERRED_FINALIZE_DEBOUNCE: "3000 millis",
  ACP_OPEN_REPLY_QUIET_LIMIT: "2 minutes",
  ACP_STOP_CONFIRM_TIMEOUT_MS: 10_000,
  ACP_TEXT_FLUSH_INTERVAL: "50 millis",
  ACP_SUBAGENT_TEXT_FLUSH_INTERVAL: "400 millis",
  ACP_LOADED_COMMANDS_WAIT: "2 seconds",
  ACP_PROMPT_INACTIVITY_SLICE_MILLIS: 60_000,
  ACP_HOST_SLEEP_TOLERANCE_MILLIS: 10_000,
} as const;
export const idleReportedSubagents = Effect.fn("AcpAdapterV2.idleReportedSubagents")(function* (
  context: ActiveAcpTurn,
  flavor: AcpAdapterV2Flavor,
  emit: (context: ActiveAcpTurn, update: AcpAdapterV2SubagentUpdate) => Effect.Effect<void>,
) {
  if (flavor.subagentsOutlivingPrompt === undefined) return;
  const nativeTaskId = (
    subagent: typeof context.subagents extends Map<string, infer V> ? V : never,
  ) => subagent.task.nativeTaskRef?.nativeId ?? String(subagent.task.id);
  const running = [...context.subagents.values()].filter((subagent) =>
    acpSubagentStatusBlocksTurnSettlement(subagent.task.status),
  );
  if (running.length === 0) return;
  const atWork = yield* flavor.subagentsOutlivingPrompt({
    sessionId: context.nativeThreadId,
    nativeTaskIds: running.map(nativeTaskId),
  });
  if (context.finalized) return;
  for (const subagent of running) {
    if (
      atWork.includes(nativeTaskId(subagent)) ||
      !acpSubagentStatusBlocksTurnSettlement(subagent.task.status)
    )
      continue;
    yield* emit(context, {
      nativeTaskId: nativeTaskId(subagent),
      prompt: subagent.task.prompt,
      title: subagent.task.title,
      model: subagent.task.model,
      status: "idle",
      childSessionId: subagent.childSessionId,
      result: null,
    });
  }
});

export function makeAcpAwaitBackgroundTasks(
  flavor: AcpAdapterV2Flavor,
  activeTurn: Ref.Ref<ActiveAcpTurn | null>,
) {
  return Effect.fn("AcpAdapterV2.awaitBackgroundTasks")(function* ({
    providerThread,
    taskIds,
  }: Parameters<
    NonNullable<ProviderAdapter.ProviderAdapterV2SessionRuntime["awaitBackgroundTasks"]>
  >[0]) {
    const outlives = flavor.toolOutlivesPrompt;
    const context = yield* Ref.get(activeTurn);
    const holdsCommand =
      outlives !== undefined &&
      flavor.deferFinalizeForBackgroundWork === true &&
      context !== null &&
      !context.finalized &&
      context.nativeThreadId === providerThread.nativeThreadRef?.nativeId &&
      [...context.tools.values()].some(
        (tool) => toolStatus(tool.status) === "running" && outlives(tool),
      );
    return { matched: holdsCommand ? [...new Set(taskIds)] : [] };
  });
}

export function takeAcpSessionPlans(
  plansBySessionId: Map<string, ActiveAcpTurn["plans"]>,
  sessionId: string,
): ActiveAcpTurn["plans"] {
  const plans = plansBySessionId.get(sessionId) ?? new Map();
  plansBySessionId.delete(sessionId);
  plansBySessionId.set(sessionId, plans);
  if (plansBySessionId.size > 8) {
    const oldest = plansBySessionId.keys().next();
    if (!oldest.done) plansBySessionId.delete(oldest.value);
  }
  return plans;
}

export function makeDeferredFinalizeScheduler(input: {
  readonly flavor: AcpAdapterV2Flavor;
  readonly enabled: () => boolean;
  readonly hasDeferredBackgroundWork: (context: ActiveAcpTurn) => boolean;
  readonly finalizeTurn: (
    context: ActiveAcpTurn,
    status: "completed" | "interrupted" | "failed" | "cancelled",
  ) => Effect.Effect<void>;
  readonly sessionScope: import("effect/Scope").Scope;
  readonly onScheduled?:
    | ((duration: import("effect/Duration").Input) => Effect.Effect<void>)
    | undefined;
}) {
  const schedule: (context: ActiveAcpTurn) => Effect.Effect<void> = Effect.fn(
    "scheduleDeferredFinalize",
  )(function* (context: ActiveAcpTurn): Effect.fn.Return<void> {
    if (
      !input.enabled() ||
      !context.promptSettled ||
      context.finalized ||
      context.interrupted ||
      input.hasDeferredBackgroundWork(context)
    )
      return;
    const generation = ++context.backgroundFinalizeGeneration;
    const replyOpen = context.replyOpen;
    const debounce = replyOpen ? "2 minutes" : "3000 millis";
    yield* Effect.gen(function* () {
      yield* Effect.sleep(debounce);
      const current = () =>
        !context.finalized &&
        !context.interrupted &&
        context.backgroundFinalizeGeneration === generation &&
        !input.hasDeferredBackgroundWork(context);
      if (!current()) return;
      const pending =
        !replyOpen && input.flavor.hasPendingReply !== undefined
          ? yield* input.flavor.hasPendingReply(context.nativeThreadId)
          : false;
      if (!current()) return;
      if (pending) {
        context.replyOpen = true;
        yield* schedule(context);
        return;
      }
      yield* input.finalizeTurn(context, context.promptSettledStatus ?? "completed");
    }).pipe(Effect.forkIn(input.sessionScope), Effect.asVoid);
    yield* input.onScheduled?.(debounce) ?? Effect.void;
  });
  return schedule;
}

export function makePostSettleHoldExpiry(input: {
  readonly flavor: AcpAdapterV2Flavor;
  readonly hasDeferredBackgroundWork: (
    context: ActiveAcpTurn,
    ignoreTool?: (tool: AcpToolCallState) => boolean,
  ) => boolean;
  readonly finalizeTurn: (
    context: ActiveAcpTurn,
    status: "completed" | "interrupted" | "failed" | "cancelled",
  ) => Effect.Effect<void>;
  readonly sessionScope: import("effect/Scope").Scope;
}) {
  return Effect.fn("AcpAdapterV2.schedulePostSettleHoldExpiry")(function* (context: ActiveAcpTurn) {
    const hold = input.flavor.postSettleCommandHold;
    if (hold === undefined || !context.promptSettled || context.finalized) return;
    const timeout = Duration.toMillis(hold.timeout);
    const isRunningCommand = (tool: AcpToolCallState) =>
      toolStatus(tool.status) === "running" && hold.isCommand(tool);
    let quietSince = yield* Clock.currentTimeMillis;
    yield* Effect.gen(function* () {
      while (!context.finalized) {
        quietSince = Math.max(quietSince, context.lastProgressAt);
        const now = yield* Clock.currentTimeMillis;
        const remaining = quietSince + timeout - now;
        if (remaining > 0) {
          yield* Effect.sleep(Duration.millis(remaining));
          continue;
        }
        if (
          [...context.tools.values()].some(isRunningCommand) &&
          !input.hasDeferredBackgroundWork(context, isRunningCommand)
        ) {
          yield* input.finalizeTurn(context, context.promptSettledStatus ?? "completed");
          return;
        }
        quietSince = now;
      }
    }).pipe(Effect.forkIn(input.sessionScope), Effect.asVoid);
  });
}

// Provider events include streaming deltas; avoid a span for each update.
export const makeRearmDeferredFinalize = (
  enabled: () => boolean,
  hasWork: (context: ActiveAcpTurn) => boolean,
  schedule: (context: ActiveAcpTurn) => Effect.Effect<void>,
) =>
  Effect.fnUntraced(function* (context: ActiveAcpTurn) {
    if (!enabled() || !context.promptSettled || context.finalized || hasWork(context)) return;
    yield* schedule(context);
  });

// Provider text arrives in streaming chunks; avoid a span for each chunk.
export const settleMessageBackgroundTools = Effect.fnUntraced(function* (
  context: ActiveAcpTurn,
  flavor: AcpAdapterV2Flavor,
  text: string,
  emitTool: (context: ActiveAcpTurn, tool: AcpToolCallState) => Effect.Effect<void>,
) {
  if (!context.promptSettled || flavor.backgroundToolMessageStatus === undefined) return;
  const reply = `${text.slice(0, 8_000)}\n${text.slice(-8_000)}`;
  for (const tool of context.tools.values()) {
    if (toolStatus(tool.status) !== "running") continue;
    const status = flavor.backgroundToolMessageStatus(tool, reply);
    if (status !== undefined) yield* emitTool(context, { ...tool, status });
  }
});

export function appendBackgroundReportChunk(
  context: ActiveAcpTurn,
  flavor: AcpAdapterV2Flavor,
  text: string,
  messageId: string | null | undefined,
): string {
  if (!context.promptSettled || flavor.backgroundToolMessageStatus === undefined) return "";
  const id = messageId || null;
  const previous = context.backgroundReportMessage;
  const prefix =
    previous !== undefined &&
    (id === null || previous.messageId === null || previous.messageId === id)
      ? previous.text
      : "";
  const next = (prefix + text.slice(0, 8_000)).slice(0, 8_000);
  context.backgroundReportMessage = { messageId: id ?? previous?.messageId ?? null, text: next };
  return next;
}

export const hasSurvivingBackgroundWork = (context: ActiveAcpTurn): boolean =>
  [...context.toolCallIdsByBackgroundTaskId.values()].some((toolCallId) => {
    const tool = context.tools.get(toolCallId);
    const status = tool === undefined ? undefined : toolStatus(tool.status);
    return status === "pending" || status === "running";
  }) ||
  [...context.subagents.values()].some((subagent) =>
    acpSubagentStatusBlocksTurnSettlement(subagent.task.status),
  );
