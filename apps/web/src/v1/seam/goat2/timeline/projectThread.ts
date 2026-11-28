// GOAT 2 seam (lane F, devlog 070 Revision A2 step 1): GOAT 2 thread log lines -> v1 projected turn items, so the lifted
// v1 timeline logic (session-logic deriveTimelineEntriesFromVisibleTurnItems, MessagesTimeline.logic
// deriveMessagesTimelineRows) and rows render GOAT 2 threads unchanged. Items are built in v1's wire form (GOAT 2's
// TurnItem was lifted from v1's, plus v1-only base fields) and decoded with v1's own schema, so dates, brands and
// unknown item types behave exactly as in v1. An item v1 cannot decode is reported in `undecodable`, never dropped
// silently.
//
// Rules: a user input shows once it reached a run (a system input as a quiet system_notice line) (run.started inputIds, or input.delivered accepted into its run); queued inputs stay in the queue banner. An item is grouped under its origin run by item.runId, also when it
// arrives after that run's run.finished (lane E, Part 2 late subagent completions). Streamed text for an unfinished
// item becomes the in-progress v1 item of its stream kind, at the end, the way v1's server folds deltas into its
// projection: assistant_text -> assistant_message, reasoning_text / reasoning_summary_text -> reasoning, plan_text ->
// proposed_plan. command_output / file_change_output are not drawn here: v1 shows live output only in the expanded
// item inspector (Part 2, details by engine locator), and GOAT 2 has no item before item.completed to hang it on.
// unknown has no v1 rendering.
import { OrchestrationV2ProjectedTurnItem } from "@goat/contracts";
import * as Schema from "effect/Schema";
import type { ContentStreamKind, LogLine, TurnItem } from "../../../../host/wire.ts";

export interface Goat2ThreadInput {
  readonly threadId: string;
  readonly lines: ReadonlyArray<LogLine>;
  readonly streaming: Readonly<Record<string, string>>;
  /** Stream kind per streaming item; absent means assistant_text (text_append without streamKind). */
  readonly streamKinds?: Readonly<Record<string, ContentStreamKind>>;
}

export interface Goat2RunSummary {
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly outcome: string | null;
}

export interface ProjectedThread {
  readonly visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  readonly runs: ReadonlyArray<Goat2RunSummary>;
  readonly activeRunId: string | null;
  readonly activeRunStartedAt: string | null;
  readonly undecodable: ReadonlyArray<{ readonly itemId: string; readonly message: string }>;
}

type Encoded = Record<string, unknown> & { readonly id: string; readonly runId: string | null };

// v1 wire JSON (ISO date strings) -> v1 types, the same codec v1 uses for JSON payloads.
const decode = Schema.decodeUnknownExit(Schema.toCodecJson(OrchestrationV2ProjectedTurnItem));

function base(threadId: string, id: string, runId: string | null, at: string, status: string, ordinal: number) {
  return {
    id, threadId, runId, nodeId: null, providerThreadId: null, providerTurnId: null, nativeItemRef: null,
    parentItemId: null, ordinal, status, title: null, startedAt: at, completedAt: status === "completed" ? at : null,
    updatedAt: at,
  };
}

function fromTurnItem(item: TurnItem): Encoded {
  return { ...item, nodeId: null } as unknown as Encoded;
}

export function projectGoat2Thread(input: Goat2ThreadInput): ProjectedThread {
  const { threadId } = input;
  const order: Encoded[] = [];
  const accepted = new Map<string, { text: string; at: string; from: string }>();
  const shown = new Set<string>();
  const runs = new Map<string, { runId: string; startedAt: string; finishedAt: string | null; outcome: string | null }>();
  let activeRunId: string | null = null;
  let activeRunStartedAt: string | null = null;
  let ordinal = 0;

  const lastIndexOfRun = (runId: string) => {
    for (let i = order.length - 1; i >= 0; i--) if (order[i]!.runId === runId) return i;
    return -1;
  };
  const place = (entry: Encoded) => {
    const runId = entry.runId;
    const run = runId === null ? undefined : runs.get(runId);
    // Late item: its run already finished and later lines followed; keep it with its run.
    if (runId !== null && run?.finishedAt) {
      const at = lastIndexOfRun(runId);
      if (at >= 0 && at < order.length - 1) {
        order.splice(at + 1, 0, entry);
        return;
      }
    }
    order.push(entry);
  };
  const showInput = (inputId: string, runId: string, intent: "turn_start" | "steer") => {
    const a = accepted.get(inputId);
    if (!a || shown.has(inputId)) return;
    shown.add(inputId);
    // A system input (engine continuation 'continuation:<key>', a wake after a late child result) is never a
    // person's message: owner rule, a quiet system line, which in v1 is a system_notice event row.
    if (a.from === "system") {
      order.push({ ...base(threadId, `input:${inputId}`, runId, a.at, "completed", ordinal++), type: "system_notice", message: a.text, severity: "info" });
      return;
    }
    order.push({
      ...base(threadId, `input:${inputId}`, runId, a.at, "completed", ordinal++),
      type: "user_message",
      createdBy: a.from === "child" ? "agent" : "user",
      creationSource: "web",
      messageId: inputId,
      inputIntent: intent,
      text: a.text,
      attachments: [],
    });
  };

  for (const line of input.lines) {
    switch (line.type) {
      case "input.accepted":
        accepted.set(line.inputId, { text: line.text, at: line.at, from: line.from.kind });
        break;
      case "input.changed":
        if (line.text !== undefined) {
          const a = accepted.get(line.inputId);
          if (a) a.text = line.text;
        }
        if (line.cancelled) accepted.delete(line.inputId);
        break;
      case "run.started":
        activeRunId = line.runId;
        activeRunStartedAt = line.at;
        runs.set(line.runId, { runId: line.runId, startedAt: line.at, finishedAt: null, outcome: null });
        for (const id of line.inputIds) showInput(id, line.runId, "turn_start");
        break;
      case "input.delivered":
        // The engine took the input into run line.runId, as a steer or as the turn start.
        if (line.outcome === "accepted") showInput(line.inputId, line.runId, line.as === "steer" ? "steer" : "turn_start");
        break;
      case "run.finished": {
        const run = runs.get(line.runId);
        if (run) { run.finishedAt = line.at; run.outcome = line.outcome; }
        if (activeRunId === line.runId) { activeRunId = null; activeRunStartedAt = null; }
        break;
      }
      case "item.completed": {
        const item = line.item;
        // Inputs are shown from input.accepted / run.started; an engine echo of the same message is not a second row.
        if (item.type === "user_message" && shown.has(item.messageId)) break;
        place(fromTurnItem(item));
        break;
      }
      default:
        break;
    }
  }
  for (const [itemId, text] of Object.entries(input.streaming)) {
    const at = activeRunStartedAt ?? new Date(0).toISOString();
    const head = base(threadId, itemId, activeRunId, at, "running", ordinal++);
    switch (input.streamKinds?.[itemId] ?? "assistant_text") {
      case "assistant_text":
        order.push({ ...head, type: "assistant_message", messageId: `stream:${itemId}`, text, streaming: true });
        break;
      case "reasoning_text":
      case "reasoning_summary_text":
        order.push({ ...head, type: "reasoning", text, streaming: true });
        break;
      case "plan_text":
        order.push({ ...head, type: "proposed_plan", planId: `plan:${itemId}`, markdown: text, streaming: true });
        break;
      default:
        break; // command_output, file_change_output, unknown: see the header
    }
  }

  const visibleTurnItems: OrchestrationV2ProjectedTurnItem[] = [];
  const undecodable: { itemId: string; message: string }[] = [];
  order.forEach((item, position) => {
    const exit = decode({ position, visibility: "local", sourceThreadId: threadId, sourceItemId: item.id, item });
    if (exit._tag === "Success") visibleTurnItems.push(exit.value);
    else undecodable.push({ itemId: item.id, message: String(exit.cause) });
  });
  return { visibleTurnItems, runs: [...runs.values()], activeRunId, activeRunStartedAt, undecodable };
}
