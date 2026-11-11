import {
  EnvironmentId,
  OrchestrationV2TurnItemJson,
  ThreadId,
  type OrchestrationV2ProjectedTurnItem,
  type ScopedThreadRef,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { EMPTY_THREAD_HISTORY_META, type ThreadHistoryMeta } from "../state/threadHistoryMerge.ts";
import {
  createGoatBotActivityStepsAtoms,
  goatBotActivityPlacement,
  goatBotActivitySources,
  goatBotSourceSteps,
  type GoatBotActivityLine,
  type GoatBotActivityPlacement,
  type GoatBotSourceSteps,
} from "./activitySteps.ts";
import { goatBotItemReaders } from "./readers.ts";
import { buildGoatBotTimeline, type GoatBotPendingInput, type GoatBotRow } from "./rows.ts";

const decode = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);
const env = EnvironmentId.make("env");
const sessionA = "goat-bot-session:a";
const sessionB = "goat-bot-session:b";
const sessionC = "goat-bot-session:c";
const at = (second: number) => `2026-11-12T03:00:${String(second).padStart(2, "0")}.000Z`;

function projected(json: object): OrchestrationV2ProjectedTurnItem {
  const item = decode(json);
  return {
    position: 0,
    visibility: "local",
    sourceThreadId: item.threadId,
    sourceItemId: item.id,
    item,
  };
}

const base = (threadId: string, id: string, second: number, status = "completed") => ({
  id,
  threadId,
  runId: threadId === "bot" ? null : "run-1",
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status,
  title: null,
  startedAt: at(second),
  completedAt: at(second),
  updatedAt: at(second),
});
const meta = { conversationId: "conv-1", originKind: "goat" };

// The bot conversation: the person's messages, GOAT Bot's replies and the hidden turn chips.
const said = (id: string, second: number) =>
  projected({
    ...base("bot", id, second),
    type: "user_message",
    messageId: "m-" + id,
    inputIntent: "turn_start",
    text: "Message " + id,
    attachments: [],
    createdBy: "user",
    creationSource: "web",
    channel: { ...meta, kind: "inbound", inputId: "in-" + id, readAt: at(second) },
  });
const replied = (id: string, second: number) =>
  projected({
    ...base("bot", id, second),
    type: "assistant_message",
    messageId: "m-" + id,
    text: "Reply " + id,
    streaming: false,
    channel: { ...meta, kind: "result" },
  });
function chip(
  id: string,
  second: number,
  worker: object,
  fields: {
    status?: string;
    version?: number;
    kind?: string;
    taskId?: string;
    createdAt?: number;
  } = {},
) {
  return projected({
    ...base("bot", id, second),
    type: "notification",
    source: { kind: "background_task" },
    outcome: "updated",
    summary: "Work updated",
    ledgerTask: {
      taskId: fields.taskId ?? "task-" + id,
      kind: fields.kind ?? "turn",
      conversationId: "conv-1",
      taskVersion: fields.version ?? 1,
      title: "Turn " + id,
      status: fields.status ?? "completed",
      originKind: "goat",
      requesterLabel: "Jun",
      createdAt: at(fields.createdAt ?? second),
      updatedAt: at(second),
      worker,
      openQuestionCount: 0,
    },
  });
}
const local = (threadId: string, runId = "run-1") => ({ environmentId: "env", threadId, runId });

// Steps on a session or worker thread.
const ran = (
  id: string,
  second: number,
  actions: object[] = [],
  extra: object = {},
  thread = sessionA,
) =>
  projected({
    ...base(thread, id, second),
    type: "command_execution",
    input: actions.length > 0 ? "cat " + id : "vp test " + id,
    commandActions: actions,
    exitCode: 0,
    ...extra,
  });
const read = (id: string, second: number, thread = sessionA) =>
  ran(id, second, [{ type: "read", path: id + ".ts" }], {}, thread);
const tool = (
  id: string,
  second: number,
  toolName: string,
  input: object = {},
  thread = sessionA,
) => projected({ ...base(thread, id, second), type: "dynamic_tool", toolName, input });
const searched = (id: string, second: number) =>
  projected({ ...base(sessionA, id, second), type: "file_search", pattern: "useEffect" });
const thought = (id: string, second: number, extra: object = {}) =>
  projected({
    ...base(sessionA, id, second),
    type: "reasoning",
    text: "Hmm",
    streaming: false,
    ...extra,
  });

function timeline(
  items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  pending: GoatBotPendingInput[] = [],
) {
  return buildGoatBotTimeline({
    visibleTurnItems: items,
    pendingInputs: pending,
    readers: goatBotItemReaders,
  });
}

function place(
  botItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  steps: ReadonlyArray<GoatBotSourceSteps>,
  options: { rows?: ReadonlyArray<GoatBotRow>; taskId?: string } = {},
): GoatBotActivityPlacement {
  return goatBotActivityPlacement({
    rows: options.rows ?? timeline(botItems),
    sources: goatBotActivitySources({
      visibleTurnItems: botItems,
      botEnvironmentId: env,
      taskId: options.taskId ?? null,
    }),
    steps,
  });
}

function lineBefore(
  placement: GoatBotActivityPlacement,
  rowId: string,
): GoatBotActivityLine | null {
  const mark = placement.beforeRow.get(rowId);
  return mark?.kind === "steps" ? mark.line : null;
}

describe("goatBotActivityPlacement", () => {
  it("shows one counted line above the reply through the real rows builder, without reasoning or report calls", () => {
    const botItems = [said("u1", 0), chip("c1", 1, local(sessionA)), replied("r1", 20)];
    const session = [
      thought("think", 2),
      read("a", 3),
      read("b", 4),
      ran("c1", 5),
      tool("report-direct", 6, "mcp__goat__goat_thread_report_result", { summary: "done" }),
      tool("report-call", 7, "goat_call", {
        path: "thread.report_result",
        args: { summary: "done" },
      }),
      tool("report-channel", 8, "mcp__goat__channel_task_report", { summary: "done" }),
      ran("c2", 9),
    ];
    const line = lineBefore(place(botItems, [goatBotSourceSteps(session, false)]), "r1");
    expect(line).toMatchObject({
      summary: "Read 2 files and ran 2 commands",
      failedCount: 0,
      live: false,
    });
    expect(line?.steps.map((step) => step.id)).toEqual(["a", "b", "c1", "c2"]);

    const withSearch = [...session, searched("s1", 10)];
    expect(
      lineBefore(place(botItems, [goatBotSourceSteps(withSearch, false)]), "r1")?.summary,
    ).toBe("Explored 2 files, 1 search and ran 2 commands");
  });

  it("splits at a question and keeps each line's steps after the chip moves to the answer's run", () => {
    const before = [
      said("u1", 0),
      chip("c1", 1, local(sessionA, "run-1"), { status: "running" }),
      replied("q1", 10),
      said("u2", 12),
      replied("r1", 30),
    ];
    // Answering starts a new run and the server rebinds the turn's chip to it.
    const rebound = [
      ...before,
      chip("c1v2", 13, local(sessionA, "run-2"), { version: 2, taskId: "task-c1", createdAt: 1 }),
    ];
    const session = [read("a", 3), ran("x", 4), ran("y", 20, [], { runId: "run-2" })];
    const placement = place(rebound, [goatBotSourceSteps(session, false)]);
    expect(lineBefore(placement, "q1")).toMatchObject({
      key: "activity:a",
      summary: "Read 1 file and ran 1 command",
    });
    expect(lineBefore(placement, "r1")).toMatchObject({
      key: "activity:y",
      summary: "Ran 1 command",
    });

    const grown = place(rebound, [goatBotSourceSteps([...session, ran("z", 21)], false)]);
    expect(lineBefore(grown, "r1")).toMatchObject({ key: "activity:y", summary: "Ran 2 commands" });
    expect(lineBefore(grown, "q1")?.key).toBe("activity:a");
  });

  it("gives each per-task session its own line and none to a third, older session", () => {
    const botItems = [
      said("u0", 0),
      chip("c0", 1, local(sessionC)),
      replied("r0", 5),
      said("u1", 10),
      chip("c1", 11, local(sessionA)),
      replied("r1", 15),
      said("u2", 20),
      chip("c2", 21, local(sessionB)),
      replied("r2", 25),
    ];
    const sources = goatBotActivitySources({
      visibleTurnItems: botItems,
      botEnvironmentId: env,
      taskId: null,
    });
    expect(sources).toEqual([
      {
        kind: "local",
        refs: [
          { environmentId: env, threadId: ThreadId.make(sessionB) },
          { environmentId: env, threadId: ThreadId.make(sessionA) },
        ],
        running: false,
      },
    ]);
    const placement = place(botItems, [
      goatBotSourceSteps([ran("b1", 22, [], {}, sessionB)], false),
      goatBotSourceSteps([read("a1", 12, sessionA)], false),
    ]);
    expect(lineBefore(placement, "r0")).toBeNull();
    expect(lineBefore(placement, "r1")?.summary).toBe("Read 1 file");
    expect(lineBefore(placement, "r2")?.summary).toBe("Ran 1 command");
  });

  it("ranks sessions by when their turn started, not when its chip last changed", () => {
    const botItems = [
      chip("c0", 1, local(sessionC)),
      chip("c1", 10, local(sessionA)),
      chip("c2", 20, local(sessionB)),
      // The oldest turn's chip changes last; it stays the oldest.
      chip("c0v2", 30, local(sessionC), { version: 2, taskId: "task-c0", createdAt: 1 }),
    ];
    const local0 = goatBotActivitySources({
      visibleTurnItems: botItems,
      botEnvironmentId: env,
      taskId: null,
    })[0];
    expect(local0?.kind === "local" ? local0.refs.map((ref) => ref.threadId) : null).toEqual([
      sessionB,
      sessionA,
    ]);
  });

  it("keeps a trailing line live while the turn runs, never split by a pending send, and done after the reply", () => {
    const running = [said("u1", 0), chip("c1", 1, local(sessionA), { status: "running" })];
    const pending: GoatBotPendingInput[] = [
      { clientKey: "k1", text: "also this", createdAt: at(3), state: "sending", requestKey: null },
    ];
    const steps = [
      goatBotSourceSteps([read("a", 2), ran("x", 4, [], { status: "running" })], false),
    ];
    const live = place(running, steps, { rows: timeline(running, pending) });
    expect(live.trailing).toMatchObject({
      kind: "steps",
      line: { live: true, summary: "Read 1 file and ran 1 command" },
    });
    expect(live.beforeRow.size).toBe(0);
    expect(
      live.trailing?.kind === "steps" ? live.trailing.line.steps.map((step) => step.state) : null,
    ).toEqual(["done", "running"]);

    const answered = [said("u1", 0), chip("c1", 1, local(sessionA)), replied("r1", 9)];
    const done = place(answered, [goatBotSourceSteps([read("a", 2), ran("x", 4)], false)]);
    expect(done.trailing).toBeNull();
    expect(lineBefore(done, "r1")).toMatchObject({ live: false, failedCount: 0 });
  });

  it("counts failed steps", () => {
    const botItems = [said("u1", 0), chip("c1", 1, local(sessionA)), replied("r1", 9)];
    const line = lineBefore(
      place(botItems, [goatBotSourceSteps([ran("x", 2, [], { exitCode: 1 }), ran("y", 3)], false)]),
      "r1",
    );
    expect(line).toMatchObject({ failedCount: 1 });
    expect(line?.steps.map((step) => step.state)).toEqual(["failed", "done"]);
  });

  it("gives no line to a gap the snapshot cut runs through or to steps before the first row", () => {
    const botItems = [
      said("u1", 10),
      chip("c1", 11, local(sessionA)),
      replied("r1", 20),
      said("u2", 30),
      replied("r2", 40),
    ];
    // The server held this session's history from second 25 on.
    const cut = goatBotSourceSteps([ran("x", 25), ran("y", 35)], true);
    const placement = place(botItems, [cut]);
    expect(lineBefore(placement, "u2")).toBeNull();
    expect(lineBefore(placement, "r2")?.summary).toBe("Ran 1 command");

    const early = place(botItems, [goatBotSourceSteps([ran("w", 5), ran("v", 15)], false)]);
    expect(lineBefore(early, "u1")).toBeNull();
    expect(lineBefore(early, "r1")?.steps.map((step) => step.id)).toEqual(["v"]);
  });

  it("counts a collapsed group's steps as earlier steps, even when its anchor is reasoning", () => {
    const botItems = [said("u1", 0), chip("c1", 1, local(sessionA)), replied("r1", 9)];
    const anchor = thought("anchor", 2, {
      deferredWork: { cursor: "c", itemCount: 200, lastOrdinal: 199 },
    });
    const withStep = lineBefore(
      place(botItems, [goatBotSourceSteps([anchor, ran("x", 3)], false)]),
      "r1",
    );
    expect(withStep).toMatchObject({
      summary: "Ran 1 command, plus 200 earlier steps",
      earlier: 200,
    });
    const alone = lineBefore(place(botItems, [goatBotSourceSteps([anchor], false)]), "r1");
    expect(alone).toMatchObject({ summary: "200 earlier steps", earlier: 200, steps: [] });
  });

  it("marks work run on another machine or server in its turn's gap, and loads nothing for it", () => {
    const botItems = [
      said("u1", 0),
      chip("c1", 1, { environmentId: "env", threadId: sessionA, host: "mac-studio" }),
      replied("r1", 9),
      said("u2", 10),
      chip("c2", 11, { environmentId: "other", threadId: sessionB }),
      replied("r2", 19),
    ];
    const sources = goatBotActivitySources({
      visibleTurnItems: botItems,
      botEnvironmentId: env,
      taskId: null,
    });
    expect(sources).toEqual([
      { kind: "elsewhere", host: "mac-studio", at: at(1) },
      { kind: "elsewhere", host: null, at: at(11) },
    ]);
    const placement = place(botItems, []);
    expect(placement.beforeRow.get("r1")).toEqual({ kind: "elsewhere", host: "mac-studio" });
    expect(placement.beforeRow.get("r2")).toEqual({ kind: "elsewhere", host: null });
  });

  it("reads a task view from the task's own worker, or marks it trailing once the task moved", () => {
    const dedicated = { environmentId: "env", threadId: "worker-1" };
    const task = [chip("t1", 1, dedicated, { kind: "work", taskId: "task-1", status: "running" })];
    expect(
      goatBotActivitySources({ visibleTurnItems: task, botEnvironmentId: env, taskId: "task-1" }),
    ).toEqual([
      {
        kind: "local",
        refs: [{ environmentId: env, threadId: ThreadId.make("worker-1") }],
        running: true,
      },
    ]);
    const moved = [
      ...task,
      chip(
        "t1v2",
        5,
        { ...dedicated, host: "mac-studio" },
        {
          kind: "work",
          taskId: "task-1",
          version: 2,
          createdAt: 1,
        },
      ),
    ];
    expect(
      goatBotActivitySources({ visibleTurnItems: moved, botEnvironmentId: env, taskId: "task-1" }),
    ).toEqual([{ kind: "elsewhere", host: "mac-studio", at: null }]);
    expect(place(moved, [], { taskId: "task-1", rows: [] }).trailing).toEqual({
      kind: "elsewhere",
      host: "mac-studio",
    });
  });

  it("names GOAT tools in expanded steps as coding threads do", () => {
    const botItems = [said("u1", 0), chip("c1", 1, local(sessionA)), replied("r1", 9)];
    const steps = goatBotSourceSteps(
      [
        tool("direct", 2, "mcp__goat__goat_thread_read", { threadId: "t-1" }),
        tool("call", 3, "goat_call", { path: "thread.read", args: { threadId: "t-1" } }),
        ran("cmd", 4),
      ],
      false,
    );
    expect(lineBefore(place(botItems, [steps]), "r1")?.steps.map((step) => step.label)).toEqual([
      "Read a GOAT thread",
      "Read a GOAT thread",
      "Ran vp test cmd",
    ]);
  });
});

describe("createGoatBotActivityStepsAtoms", () => {
  it("keeps the same steps while only assistant or reasoning text streams", () => {
    const items = Atom.make<ReadonlyArray<OrchestrationV2ProjectedTurnItem>>([]);
    const history = Atom.make<ThreadHistoryMeta>(EMPTY_THREAD_HISTORY_META);
    const atoms = createGoatBotActivityStepsAtoms({
      quietVisibleTurnItemsAtom: () => items,
      historyAtom: () => history,
    });
    const registry = AtomRegistry.make();
    const ref: ScopedThreadRef = { environmentId: env, threadId: ThreadId.make(sessionA) };
    const stepsAtom = atoms.stepsAtom(ref);
    const unmount = registry.mount(stepsAtom);
    const running = ran("x", 2, [], { status: "running", output: "a" });
    registry.set(items, [thought("t", 1), running]);
    const first = registry.get(stepsAtom);
    expect(first.steps.map((step) => step.id)).toEqual(["x"]);

    // New reasoning, a reply and more output from the same running command change no step.
    registry.set(items, [
      thought("t", 1),
      thought("t2", 2),
      ran("x", 2, [], { status: "running", output: "a\nb" }),
      projected({
        ...base(sessionA, "m", 3),
        type: "assistant_message",
        messageId: "m",
        text: "Hi",
        streaming: true,
      }),
    ]);
    expect(registry.get(stepsAtom)).toBe(first);

    registry.set(items, [thought("t", 1), ran("x", 2)]);
    const finished = registry.get(stepsAtom);
    expect(finished).not.toBe(first);
    expect(finished.steps.map((step) => step.state)).toEqual(["done"]);
    unmount();
  });
});
