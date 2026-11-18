import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import * as DateTime from "effect/DateTime";
import {
  CLAUDE_SCHEDULED_WAKEUP_EARLY_FIRE_MARGIN_MS,
  claudeToolResultBlocksFromUserMessage,
  claudeToolUseBlocksFromAssistantMessage,
  isClaudeTurnStartMessage,
} from "./ClaudeToolFrames.ts";
import type { RunId } from "@goat/contracts";
import {
  type BackgroundWorkReport,
  backgroundWorkNotification,
} from "@goat/provider-core/server/notification";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

interface ClaudeWakeReportEntry {
  readonly report: BackgroundWorkReport;
  readonly turn: number;
  readonly runId?: RunId;
}

interface ClaudeWakeReportState {
  readonly userTurns: ReadonlyMap<string, number>;
  readonly reports: ReadonlyMap<string, ReadonlyMap<string, ClaudeWakeReportEntry>>;
}

// Wake results lack task ids and can follow queued prompts; retain reports for one user turn.
// Keep report stamps atomic with turn changes.
export const makeClaudeWakeReports = Effect.fn("ClaudeWakeReports.make")(function* (
  wakeRunByTaskId: Ref.Ref<Map<string, RunId>>,
) {
  const wakeReportsByNativeThread = yield* Ref.make<ClaudeWakeReportState>({
    userTurns: new Map(),
    reports: new Map(),
  });
  const recordWakeReport = (nativeThreadId: string, taskId: string, report: BackgroundWorkReport) =>
    // The report keeps the run from here on, so the task's entry goes.
    Ref.modify(wakeRunByTaskId, (runs) => {
      if (!runs.has(taskId)) return [undefined, runs] as const;
      const rest = new Map(runs);
      rest.delete(taskId);
      return [runs.get(taskId), rest] as const;
    }).pipe(
      Effect.flatMap((taken) =>
        Ref.update(wakeReportsByNativeThread, ({ userTurns, reports }) => {
          const runId = taken ?? reports.get(nativeThreadId)?.get(taskId)?.runId;
          return {
            userTurns,
            reports: new Map(reports).set(
              nativeThreadId,
              new Map(reports.get(nativeThreadId)).set(taskId, {
                report,
                turn: userTurns.get(nativeThreadId) ?? 0,
                ...(runId === undefined ? {} : { runId }),
              }),
            ),
          };
        }),
      ),
    );
  const startUserTurnForWakeReports = (nativeThreadId: string) =>
    Ref.update(wakeReportsByNativeThread, ({ userTurns, reports }) => {
      const turn = (userTurns.get(nativeThreadId) ?? 0) + 1;
      const updatedTurns = new Map(userTurns).set(nativeThreadId, turn);
      const threadReports = reports.get(nativeThreadId);
      if (threadReports === undefined) return { userTurns: updatedTurns, reports };
      const kept = new Map([...threadReports].filter(([, entry]) => entry.turn >= turn - 1));
      const updatedReports = new Map(reports);
      if (kept.size === 0) updatedReports.delete(nativeThreadId);
      else updatedReports.set(nativeThreadId, kept);
      return { userTurns: updatedTurns, reports: updatedReports };
    });
  const takeWakeReports = (nativeThreadId: string) =>
    Ref.modify(wakeReportsByNativeThread, (current) => {
      const taken = current.reports.get(nativeThreadId);
      if (taken === undefined) return [taken, current] as const;
      const reports = new Map(current.reports);
      reports.delete(nativeThreadId);
      return [taken, { userTurns: current.userTurns, reports }] as const;
    });
  const clearWakeReports = (nativeThreadId: string) =>
    takeWakeReports(nativeThreadId).pipe(Effect.asVoid);
  const peekWakeReports = (nativeThreadId: string) =>
    Ref.get(wakeReportsByNativeThread).pipe(
      Effect.map(({ reports }) => reports.get(nativeThreadId)),
    );
  /** Forgets the reports of tasks whose buffered wake was retired. */
  const dropWakeReports = (nativeThreadId: string, taskIds: ReadonlySet<string>) =>
    Ref.update(wakeReportsByNativeThread, ({ userTurns, reports }) => {
      const threadReports = reports.get(nativeThreadId);
      if (threadReports === undefined) return { userTurns, reports };
      const remaining = new Map([...threadReports].filter(([taskId]) => !taskIds.has(taskId)));
      const updatedReports = new Map(reports);
      if (remaining.size === 0) updatedReports.delete(nativeThreadId);
      else updatedReports.set(nativeThreadId, remaining);
      return { userTurns, reports: updatedReports };
    });
  return {
    recordWakeReport,
    startUserTurnForWakeReports,
    takeWakeReports,
    clearWakeReports,
    peekWakeReports,
    dropWakeReports,
  };
});

/** Tasks that never notify keep their stamp; the oldest go past this many. */
const MAX_STAMPED_TASKS = 256;

export const remember = (
  wakeRunByTaskId: Ref.Ref<Map<string, RunId>>,
  taskId: string,
  runId: RunId | null | undefined,
) => {
  if (runId === undefined || runId === null) return Effect.void;
  return Ref.update(wakeRunByTaskId, (current) => {
    if (current.get(taskId) === runId) return current;
    const updated = new Map(current);
    updated.delete(taskId);
    updated.set(taskId, runId);
    for (const oldest of updated.keys()) {
      if (updated.size <= MAX_STAMPED_TASKS) break;
      updated.delete(oldest);
    }
    return updated;
  });
};

export const claudeWakeNotification = (
  reports: ReadonlyMap<string, ClaudeWakeReportEntry> | undefined,
) => {
  const entries = [...(reports?.values() ?? [])];
  const notification = backgroundWorkNotification(entries.map((entry) => entry.report));
  const runId = entries[0]?.runId;
  if (
    notification === null ||
    runId === undefined ||
    entries.some((entry) => entry.runId !== runId)
  )
    return notification;
  return { ...notification, aboutRunId: runId };
};

export function isClaudeTaskNotificationOriginResult(
  message: SDKMessage,
): message is SDKResultMessage & {
  readonly origin: Extract<
    NonNullable<SDKResultMessage["origin"]>,
    { readonly kind: "task-notification" }
  >;
} {
  return message.type === "result" && message.origin?.kind === "task-notification";
}

export function claudeScheduledWakes(rootIsIdle: Effect.Effect<boolean>) {
  // ScheduleWakeup reports no background task: its tool result is the only sign that Claude
  // will start a turn by itself, and Claude keeps one pending wakeup per session. It stays
  // out of pendingBackgroundTasksByNativeThread because a wakeup must not refuse a model or
  // mode change; replacing the process cancels it, and that clears this record too.
  const scheduleWakeupCalls = new Set<string>();
  const scheduledWakeupsByNativeThread = new Map<string, number>();
  // Native threads whose current turn Claude started by itself inside the early-fire margin.
  const possibleEarlyWakeNativeThreads = new Set<string>();
  const trackClaudeScheduledWakeup = Effect.fnUntraced(function* (
    nativeThreadId: string,
    message: SDKMessage,
  ) {
    if (isClaudeTurnStartMessage(message)) {
      const scheduledFor = scheduledWakeupsByNativeThread.get(nativeThreadId);
      if (scheduledFor === undefined) return;
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      if (now >= scheduledFor) {
        scheduledWakeupsByNativeThread.delete(nativeThreadId);
      } else if (
        (yield* rootIsIdle) &&
        now >= scheduledFor - CLAUDE_SCHEDULED_WAKEUP_EARLY_FIRE_MARGIN_MS
      ) {
        possibleEarlyWakeNativeThreads.add(nativeThreadId);
      }
      return;
    }
    // A task notification also starts a turn by itself, so an early turn is the wake only
    // when its result is not a task notification's.
    if (message.type === "result") {
      if (
        possibleEarlyWakeNativeThreads.delete(nativeThreadId) &&
        !isClaudeTaskNotificationOriginResult(message)
      ) {
        scheduledWakeupsByNativeThread.delete(nativeThreadId);
      }
      return;
    }
    for (const toolUse of claudeToolUseBlocksFromAssistantMessage(message)) {
      if (toolUse.name === "ScheduleWakeup") scheduleWakeupCalls.add(toolUse.id);
    }
    if (message.type !== "user") return;
    const returned = claudeToolResultBlocksFromUserMessage(message).filter((toolResult) =>
      scheduleWakeupCalls.delete(toolResult.tool_use_id),
    );
    if (returned.length === 0) return;
    const result = message.tool_use_result;
    const scheduledFor =
      returned.length === 1 && typeof result === "object" && result !== null
        ? Reflect.get(result, "scheduledFor")
        : undefined;
    // stop:true reports scheduledFor 0. A failed call also clears: losing the hold early
    // is recoverable, a hold that outlives its wakeup is not.
    possibleEarlyWakeNativeThreads.delete(nativeThreadId);
    if (typeof scheduledFor === "number" && scheduledFor > 0) {
      scheduledWakeupsByNativeThread.set(nativeThreadId, scheduledFor);
    } else {
      scheduledWakeupsByNativeThread.delete(nativeThreadId);
    }
  });
  const forgetScheduledWake = (nativeThreadId: string) => {
    scheduledWakeupsByNativeThread.delete(nativeThreadId);
    scheduleWakeupCalls.clear();
    possibleEarlyWakeNativeThreads.delete(nativeThreadId);
  };
  return { scheduledWakeupsByNativeThread, trackClaudeScheduledWakeup, forgetScheduledWake };
}
