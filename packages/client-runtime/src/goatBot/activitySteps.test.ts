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
  goatBotActivityRowTurns,
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
// A reply or question names the turn it answers for, as the server's receipts do.
const replied = (id: string, second: number, taskId?: string) =>
  projected({
    ...base("bot", id, second),
    type: "assistant_message",
    messageId: "m-" + id,
    text: "Reply " + id,
    streaming: false,
    channel: { ...meta, kind: "result", ...(taskId === undefined ? {} : { taskId }) },
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
    sources: sourcesOf(botItems, options.taskId ?? null),
    steps,
    rowTurns: goatBotActivityRowTurns(botItems),
  });
}

function sourcesOf(
  botItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  taskId: string | null = null,
) {
  return goatBotActivitySources({
    visibleTurnItems: botItems,
    botEnvironmentId: env,
    taskId,
    boundedSnapshots: true,
  });
}

const turn = (taskId: string, second: number, running = false) => ({
  taskId,
  since: at(second),
  running,
});

function lineBefore(
  placement: GoatBotActivityPlacement,
  rowId: string,
): GoatBotActivityLine | null {
  const mark = placement.beforeRow.get(rowId);
  return mark?.kind === "steps" ? mark.line : null;
}

describe("goatBotActivityPlacement", () => {
  it("shows one counted line above the reply through the real rows builder, without reasoning or report calls", () => {
    const botItems = [said("u1", 0), chip("c1", 1, local(sessionA)), replied("r1", 20, "task-c1")];
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

  it("puts a requester's steps above their own reply when another requester's session overlaps it", () => {
    // B asks after A, works on its own session, and A's reply lands while B still runs.
    const overlapping = [
      said("ua", 0),
      chip("ca", 1, local(sessionA, "run-a")),
      said("ub", 2),
      chip("cb", 3, local(sessionB, "run-b"), { status: "running" }),
      replied("ra", 10, "task-ca"),
    ];
    const bSteps = [ran("b1", 5, [], { runId: "run-b" }, sessionB)];
    const live = place(overlapping, [goatBotSourceSteps(bSteps, false)]);
    expect(lineBefore(live, "ra")).toBeNull();
    expect(live.trailing).toMatchObject({
      kind: "steps",
      line: { live: true, summary: "Ran 1 command" },
    });

    const answered = [
      ...overlapping.slice(0, 3),
      chip("cb", 3, local(sessionB, "run-b")),
      replied("ra", 10, "task-ca"),
      replied("rb", 20, "task-cb"),
    ];
    const done = place(answered, [goatBotSourceSteps(bSteps, false)]);
    expect(lineBefore(done, "ra")).toBeNull();
    expect(lineBefore(done, "rb")?.steps.map((step) => step.id)).toEqual(["b1"]);
    expect(done.trailing).toBeNull();
  });

  it("keeps a queued request's work out of the run before it, across the person's later message", () => {
    const botItems = [
      said("u1", 0),
      chip("c1", 1, local(sessionA, "run-1")),
      said("u2", 3),
      chip("c2", 4, local(sessionA, "run-2")),
      replied("r1", 8, "task-c1"),
      replied("r2", 12, "task-c2"),
    ];
    const session = [ran("x", 2), read("y", 5), ran("z", 9, [], { runId: "run-2" })];
    const placement = place(botItems, [goatBotSourceSteps(session, false)]);
    expect(placement.beforeRow.has("u2")).toBe(false);
    expect(lineBefore(placement, "r1")?.steps.map((step) => step.id)).toEqual(["x", "y"]);
    expect(lineBefore(placement, "r2")?.steps.map((step) => step.id)).toEqual(["z"]);
  });

  it("gives no line to a turn's earlier run once its chip names the run after the answer", () => {
    const before = [
      said("u1", 0),
      chip("c1", 1, local(sessionA, "run-1"), { status: "running" }),
      replied("q1", 10, "task-c1"),
      said("u2", 12),
      replied("r1", 30, "task-c1"),
    ];
    const session = [read("a", 3), ran("x", 4), ran("y", 20, [], { runId: "run-2" })];
    // While the first run is the chip's, its steps sit above the question.
    expect(lineBefore(place(before, [goatBotSourceSteps(session, false)]), "q1")).toMatchObject({
      key: "activity:a",
      summary: "Read 1 file and ran 1 command",
    });
    // Answering starts a new run and the server rebinds the turn's chip to it.
    const rebound = [
      ...before,
      chip("c1v2", 13, local(sessionA, "run-2"), { version: 2, taskId: "task-c1", createdAt: 1 }),
    ];
    const placement = place(rebound, [goatBotSourceSteps(session, false)]);
    expect(lineBefore(placement, "q1")).toBeNull();
    expect(lineBefore(placement, "r1")).toMatchObject({
      key: "activity:y",
      summary: "Ran 1 command",
    });

    const grown = place(rebound, [
      goatBotSourceSteps([...session, ran("z", 21, [], { runId: "run-2" })], false),
    ]);
    expect(lineBefore(grown, "r1")).toMatchObject({ key: "activity:y", summary: "Ran 2 commands" });
  });

  it("reads only the newest per-task session, so older turns on other sessions get no line", () => {
    const botItems = [
      said("u0", 0),
      chip("c0", 1, local(sessionC)),
      replied("r0", 5, "task-c0"),
      said("u1", 10),
      chip("c1", 11, local(sessionA)),
      replied("r1", 15, "task-c1"),
      said("u2", 20),
      chip("c2", 21, local(sessionB)),
      replied("r2", 25, "task-c2"),
    ];
    expect(sourcesOf(botItems)).toEqual([
      {
        kind: "local",
        refs: [{ environmentId: env, threadId: ThreadId.make(sessionB) }],
        running: false,
        runs: new Map([["run-1", turn("task-c2", 21)]]),
      },
    ]);
    const placement = place(botItems, [
      goatBotSourceSteps([ran("b1", 22, [], {}, sessionB)], false),
    ]);
    expect(lineBefore(placement, "r0")).toBeNull();
    expect(lineBefore(placement, "r1")).toBeNull();
    expect(lineBefore(placement, "r2")?.summary).toBe("Ran 1 command");
  });

  it("reads nothing from a server that sends a thread's whole history", () => {
    const botItems = [
      said("u1", 0),
      chip("c1", 1, local(sessionA)),
      chip("c2", 2, { environmentId: "env", threadId: sessionB, host: "mac-studio" }),
    ];
    const task = [
      chip(
        "t1",
        1,
        { environmentId: "env", threadId: "worker-1" },
        { kind: "work", taskId: "task-1" },
      ),
    ];
    const whole = (items: typeof botItems, taskId: string | null) =>
      goatBotActivitySources({
        visibleTurnItems: items,
        botEnvironmentId: env,
        taskId,
        boundedSnapshots: false,
      });
    expect(whole(botItems, null)).toEqual([
      { kind: "elsewhere", host: "mac-studio", at: at(2), turn: turn("task-c2", 2) },
    ]);
    expect(whole(task, "task-1")).toEqual([]);
  });

  it("ranks sessions by when their turn started, not when its chip last changed", () => {
    const botItems = [
      chip("c0", 1, local(sessionC)),
      chip("c1", 10, local(sessionA)),
      chip("c2", 20, local(sessionB)),
      // The oldest turn's chip changes last; it stays the oldest.
      chip("c0v2", 30, local(sessionC), { version: 2, taskId: "task-c0", createdAt: 1 }),
    ];
    const local0 = sourcesOf(botItems)[0];
    expect(local0?.kind === "local" ? local0.refs.map((ref) => ref.threadId) : null).toEqual([
      sessionB,
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

    const answered = [said("u1", 0), chip("c1", 1, local(sessionA)), replied("r1", 9, "task-c1")];
    const done = place(answered, [goatBotSourceSteps([read("a", 2), ran("x", 4)], false)]);
    expect(done.trailing).toBeNull();
    expect(lineBefore(done, "r1")).toMatchObject({ live: false, failedCount: 0 });
  });

  it("counts failed steps", () => {
    const botItems = [said("u1", 0), chip("c1", 1, local(sessionA)), replied("r1", 9, "task-c1")];
    const line = lineBefore(
      place(botItems, [goatBotSourceSteps([ran("x", 2, [], { exitCode: 1 }), ran("y", 3)], false)]),
      "r1",
    );
    expect(line).toMatchObject({ failedCount: 1 });
    expect(line?.steps.map((step) => step.state)).toEqual(["failed", "done"]);
  });

  it("gives no line to a stretch that opens before the session's held history", () => {
    const botItems = [
      said("u1", 20),
      chip("c1", 22, local(sessionA)),
      replied("q1", 30, "task-c1"),
      replied("r1", 40, "task-c1"),
    ];
    // The server held this session's history from second 26 on; the turn began at 22.
    const cut = goatBotSourceSteps([ran("x", 26), ran("y", 35)], true);
    const placement = place(botItems, [cut]);
    expect(lineBefore(placement, "q1")).toBeNull();
    expect(lineBefore(placement, "r1")?.steps.map((step) => step.id)).toEqual(["y"]);
  });

  it("names a collapsed group as earlier work without a count, even when its anchor is reasoning", () => {
    const botItems = [said("u1", 0), chip("c1", 1, local(sessionA)), replied("r1", 9, "task-c1")];
    // The server's count includes reasoning, so 151 thoughts must not read as 151 steps.
    const anchor = thought("anchor", 2, {
      deferredWork: { cursor: "c", itemCount: 151, lastOrdinal: 150 },
    });
    const withStep = lineBefore(
      place(botItems, [goatBotSourceSteps([anchor, ran("x", 3)], false)]),
      "r1",
    );
    expect(withStep).toMatchObject({ summary: "Ran 1 command, plus earlier work", earlier: true });
    const alone = lineBefore(place(botItems, [goatBotSourceSteps([anchor], false)]), "r1");
    expect(alone).toMatchObject({ summary: "Earlier work", earlier: true, steps: [] });
  });

  it("marks work run on another machine or server above its own turn's reply, and loads nothing for it", () => {
    const botItems = [
      said("u1", 0),
      chip("c1", 1, { environmentId: "env", threadId: sessionA, host: "mac-studio" }),
      said("u2", 5),
      chip("c2", 6, { environmentId: "other", threadId: sessionB }),
      replied("r2", 15, "task-c2"),
      replied("r1", 19, "task-c1"),
    ];
    expect(sourcesOf(botItems)).toEqual([
      { kind: "elsewhere", host: "mac-studio", at: at(1), turn: turn("task-c1", 1) },
      { kind: "elsewhere", host: null, at: at(6), turn: turn("task-c2", 6) },
    ]);
    const placement = place(botItems, []);
    expect(placement.beforeRow.get("r1")).toEqual({ kind: "elsewhere", host: "mac-studio" });
    expect(placement.beforeRow.get("r2")).toEqual({ kind: "elsewhere", host: null });
    expect(placement.beforeRow.has("u2")).toBe(false);
  });

  it("reads a task view from the task's own worker, or marks it trailing once the task moved", () => {
    const dedicated = { environmentId: "env", threadId: "worker-1" };
    const task = [chip("t1", 1, dedicated, { kind: "work", taskId: "task-1", status: "running" })];
    expect(sourcesOf(task, "task-1")).toEqual([
      {
        kind: "local",
        refs: [{ environmentId: env, threadId: ThreadId.make("worker-1") }],
        running: true,
        runs: null,
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
    expect(sourcesOf(moved, "task-1")).toEqual([
      { kind: "elsewhere", host: "mac-studio", at: null, turn: null },
    ]);
    expect(place(moved, [], { taskId: "task-1", rows: [] }).trailing).toEqual({
      kind: "elsewhere",
      host: "mac-studio",
    });
  });

  it("names GOAT tools in expanded steps as coding threads do", () => {
    const botItems = [said("u1", 0), chip("c1", 1, local(sessionA)), replied("r1", 9, "task-c1")];
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

  it("lets go of the source thread once the last reader unmounts", () => {
    let reading = 0;
    const items = Atom.make<ReadonlyArray<OrchestrationV2ProjectedTurnItem>>([]);
    // Stands for the thread's live subscription: it runs only while something reads it.
    const subscription = Atom.make((get) => {
      reading += 1;
      get.addFinalizer(() => {
        reading -= 1;
      });
      return get(items);
    });
    const history = Atom.make<ThreadHistoryMeta>(EMPTY_THREAD_HISTORY_META);
    const atoms = createGoatBotActivityStepsAtoms({
      quietVisibleTurnItemsAtom: () => subscription,
      historyAtom: () => history,
    });
    const tasks: Array<() => void> = [];
    const registry = AtomRegistry.make({
      scheduleTask: (task) => {
        tasks.push(task);
        return () => {};
      },
    });
    const settle = () => {
      for (const task of tasks.splice(0)) task();
    };
    const ref: ScopedThreadRef = { environmentId: env, threadId: ThreadId.make(sessionA) };
    const first = registry.mount(atoms.stepsAtom(ref));
    const second = registry.mount(atoms.stepsAtom(ref));
    expect(reading).toBe(1);
    first();
    settle();
    expect(reading).toBe(1);
    second();
    settle();
    expect(reading).toBe(0);
  });
});
