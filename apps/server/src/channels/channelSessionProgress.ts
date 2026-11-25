/**
 * What a GOAT Bot session has done for one request while its first reply is still owed: whether it
 * is answering, still composing, working with tools, or waiting behind another request.
 */
import type { ChannelTask, OrchestrationV2TurnItem, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { WORKSPACE_PREPARATION_INPUT } from "../orchestration-v2/preparationItem.ts";
import { isTerminalRun, sessionTaskRuns } from "./channelBotSessionRuns.ts";
import { noticeMessageIds } from "./channelNoticeAnswers.ts";

export type SessionProgress =
  | { readonly kind: "answering" | "composing" | "queued" | "ended" }
  | { readonly kind: "working"; readonly steps: ReadonlyArray<string> };

const STEP_CHARS = 120;
const STEPS_TOLD = 3;

const pathOf = (input: unknown) =>
  typeof input === "object" && input !== null && "path" in input && typeof input.path === "string"
    ? " " + input.path
    : "";

/** A provider item that is work toward the answer, in words the acknowledgment can pass on. */
const workStep = (item: OrchestrationV2TurnItem): string | undefined => {
  switch (item.type) {
    case "command_execution":
      return item.input === WORKSPACE_PREPARATION_INPUT ? undefined : "ran " + item.input;
    case "dynamic_tool":
      return "called " + (item.toolName ?? "a tool") + pathOf(item.input);
    case "web_search":
      return "searched the web" + (item.patterns?.length ? " for " + item.patterns.join(", ") : "");
    case "file_search":
      return "searched files" + (item.pattern === undefined ? "" : " for " + item.pattern);
    case "file_change":
      return "prepared a file change";
    case "subagent":
      return "asked a helper: " + item.prompt;
    default:
      return undefined;
  }
};

export const sessionProgress = Effect.fn("ChannelSessionFirst.progress")(function* (
  sql: SqlClient.SqlClient,
  threads: ThreadManagement.ThreadManagementService["Service"],
  task: Pick<ChannelTask, "taskId" | "generation">,
) {
  const intents = yield* sql<{ readonly thread_id: ThreadId }>`SELECT DISTINCT thread_id
    FROM channel_bot_session_runs WHERE task_id = ${task.taskId}
      AND task_generation = ${task.generation}`;
  const steps: Array<string> = [];
  let owned = 0;
  let live = false;
  let queued = false;
  for (const { thread_id: threadId } of intents) {
    const records = yield* threads.getThreadRecords(threadId, ["runs", "messages", "turnItems"]);
    // A background command's notice answers on its own path, so its run is not this request's.
    const notices = noticeMessageIds(records.messages);
    const runs = (yield* sessionTaskRuns(sql, threadId, records, task)).filter(
      (run) => !notices.has(run.userMessageId),
    );
    const ids = new Set<string>(runs.map((run) => run.id));
    const items = records.turnItems
      .filter((item) => item.runId !== null && ids.has(item.runId) && item.parentItemId === null)
      .toSorted((a, b) => a.ordinal - b.ordinal);
    if (items.some((item) => item.type === "assistant_message"))
      return { kind: "answering" } as const;
    for (const item of items) {
      const step = workStep(item);
      if (step !== undefined) steps.push(step.slice(0, STEP_CHARS));
    }
    owned += runs.length;
    for (const run of runs) {
      if (run.status === "queued") queued = true;
      else if (!isTerminalRun(run)) live = true;
    }
  }
  if (steps.length > 0) return { kind: "working", steps: steps.slice(-STEPS_TOLD) } as const;
  if (live) return { kind: "composing" } as const;
  if (queued || owned === 0) return { kind: "queued" } as const;
  return { kind: "ended" } as const;
});

/** What acknowledgment-only reception is told about a session that has not replied itself. */
export const progressSummary = (
  progress: SessionProgress | undefined,
  task: Pick<ChannelTask, "title">,
) =>
  progress?.kind === "working"
    ? "GOAT Bot is looking into the request. Steps so far: " + progress.steps.join("; ") + "."
    : progress?.kind === "queued"
      ? "The request is queued: GOAT Bot starts it as soon as it finishes the request before it."
      : "GOAT Bot is handling the request: " + task.title + ".";
