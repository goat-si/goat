import {
  ChannelConversationId,
  ChannelTaskId,
  EnvironmentId,
  NodeId,
  OrchestrationV2TurnItemJson,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type ChannelTaskChip,
  type OrchestrationV2ProjectedTurnItem,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { Atom, AtomRegistry } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  goatBotActivity,
  goatBotActivityTask,
  observeResidentAtom,
  residentAtomValue,
  type GoatBotWorkerObservation,
} from "./activity.ts";
import { goatBotItemReaders } from "./readers.ts";

const decode = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);
const at = (second: number) => `2026-10-28T12:00:${String(second).padStart(2, "0")}.000Z`;
const env = EnvironmentId.make("env");
const session = ThreadId.make("goat-bot-session:conv-1");
const runA = RunId.make("run-a");
const runB = RunId.make("run-b");

const chip = (taskId: string, overrides: Partial<ChannelTaskChip> = {}): ChannelTaskChip => ({
  taskId: ChannelTaskId.make(taskId),
  conversationId: ChannelConversationId.make("conv-1"),
  taskVersion: 1,
  title: "Check disk space",
  status: "running",
  originKind: "goat",
  requesterLabel: "Jun",
  createdAt: at(1),
  updatedAt: at(1),
  worker: { environmentId: env, threadId: ThreadId.make(`worker-${taskId}`) },
  openQuestionCount: 0,
  ...overrides,
});

type Entry =
  | { readonly kind: "user"; readonly inputId: string; readonly second: number }
  | {
      readonly kind: "bot";
      readonly text: string;
      readonly second: number;
      readonly taskId?: string;
      readonly replyTo?: string;
      readonly channelKind?: "receipt" | "status" | "result" | "question";
    }
  | { readonly kind: "card"; readonly chip: ChannelTaskChip; readonly second: number };

function timeline(...entries: ReadonlyArray<Entry>): OrchestrationV2ProjectedTurnItem[] {
  return entries.map((entry, index) => {
    const second = entry.second;
    const base = {
      id: `item-${index}`,
      threadId: "bot",
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: index,
      status: "completed",
      title: null,
      startedAt: at(second),
      completedAt: at(second),
      updatedAt: at(second),
    };
    const meta = { conversationId: "conv-1", originKind: "goat" };
    const item = decode(
      entry.kind === "user"
        ? {
            ...base,
            type: "user_message",
            messageId: `m-${index}`,
            inputIntent: "turn_start",
            text: "hello",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
            channel: { ...meta, kind: "inbound", inputId: entry.inputId, readAt: at(second) },
          }
        : entry.kind === "bot"
          ? {
              ...base,
              type: "assistant_message",
              messageId: `m-${index}`,
              text: entry.text,
              streaming: false,
              channel: {
                ...meta,
                kind: entry.channelKind ?? "receipt",
                ...(entry.taskId === undefined ? {} : { taskId: entry.taskId }),
                ...(entry.replyTo === undefined ? {} : { inReplyToInputId: entry.replyTo }),
              },
            }
          : {
              ...base,
              type: "notification",
              source: { kind: "background_task" },
              outcome: "updated",
              summary: "Work updated",
              ledgerTask: entry.chip,
            },
    );
    return {
      position: index,
      visibility: "local",
      sourceThreadId: ThreadId.make("bot"),
      sourceItemId: item.id,
      item,
    };
  });
}

const working = (
  items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  worker: GoatBotWorkerObservation | null = null,
) =>
  goatBotActivity({
    reading: false,
    task: goatBotActivityTask({ visibleTurnItems: items, readers: goatBotItemReaders }),
    worker,
  });

const acknowledged = (task: ChannelTaskChip, ...later: ReadonlyArray<Entry>) =>
  timeline(
    { kind: "user", inputId: "in-1", second: 1 },
    { kind: "bot", text: "On it.", replyTo: "in-1", taskId: task.taskId, second: 2 },
    { kind: "card", chip: task, second: 2 },
    ...later,
  );

const tool = (
  title: string | null,
  runId: RunId | null,
  second: number,
  status: "running" | "waiting" | "pending" | "completed" = "running",
  type: "command_execution" | "subagent" = "command_execution",
) => ({ type, runId, status, title, updatedAt: DateTime.makeUnsafe(at(second)) });

describe("goatBotActivity", () => {
  it("reads the newest message, then works on the task its acknowledgement started", () => {
    const task = chip("task-1");
    const beforeAck = timeline({ kind: "user", inputId: "in-1", second: 1 });
    expect(
      goatBotActivity({
        reading: true,
        task: goatBotActivityTask({ visibleTurnItems: beforeAck, readers: goatBotItemReaders }),
        worker: null,
      }),
    ).toEqual({ state: "reading", text: "Reading your message" });
    expect(working(beforeAck)).toBeNull();
    expect(working(acknowledged(task))).toEqual({ state: "working", text: "Working" });
  });

  it("follows the task the acknowledgement names at its newest revision, not card order", () => {
    const other = chip("task-0", { title: "Older work", summary: "Other progress" });
    const task = chip("task-1", { summary: "First pass" });
    const items = timeline(
      { kind: "card", chip: other, second: 0 },
      { kind: "user", inputId: "in-1", second: 1 },
      { kind: "bot", text: "On it.", replyTo: "in-1", taskId: "task-1", second: 2 },
      { kind: "card", chip: task, second: 2 },
      { kind: "card", chip: { ...task, taskVersion: 3, summary: "Second pass" }, second: 4 },
      { kind: "card", chip: { ...task, taskVersion: 2, summary: "Stale pass" }, second: 5 },
    );
    expect(working(items)?.text).toBe("Second pass");
  });

  it("stops when the task finishes and returns to older acknowledged work still running", () => {
    const older = chip("task-0", { summary: "Older work" });
    const newer = chip("task-1");
    const items = timeline(
      { kind: "user", inputId: "in-0", second: 0 },
      { kind: "bot", text: "Starting.", replyTo: "in-0", taskId: "task-0", second: 0 },
      { kind: "card", chip: older, second: 0 },
      { kind: "user", inputId: "in-1", second: 1 },
      { kind: "bot", text: "On it.", replyTo: "in-1", taskId: "task-1", second: 2 },
      { kind: "card", chip: newer, second: 2 },
    );
    expect(working(items)?.text).toBe("Working");
    const finished = [
      ...items,
      ...timeline({
        kind: "card",
        chip: { ...newer, taskVersion: 2, status: "completed" },
        second: 6,
      }),
    ];
    expect(working(finished)?.text).toBe("Older work");
    const allDone = [
      ...finished,
      ...timeline({
        kind: "card",
        chip: { ...older, taskVersion: 2, status: "failed" },
        second: 7,
      }),
    ];
    expect(working(allDone)).toBeNull();
  });

  it("never follows a task its acknowledgement did not name, even one created at the same moment", () => {
    const primary = chip("task-1");
    const unlinked = chip("task-2", { summary: "Someone else's work" });
    const items = acknowledged(
      { ...primary, status: "completed" },
      { kind: "card", chip: unlinked, second: 3 },
    );
    expect(working(items)).toBeNull();
  });

  it.each([
    [
      { observed: { pullRequests: [], needsYou: [{ kind: "approval", since: at(3) }] } },
      "Waiting for your approval",
    ],
    [{ openQuestionCount: 1, status: "waiting_input" }, "Waiting for your answer"],
    [
      { observed: { pullRequests: [], needsYou: [{ kind: "question", since: at(3) }] } },
      "Waiting for your answer",
    ],
    [
      { observed: { pullRequests: [], needsYou: [{ kind: "sign_in", since: at(3) }] } },
      "Waiting for you to sign in",
    ],
    [
      { observed: { pullRequests: [], needsYou: [{ kind: "usage_limit", since: at(3) }] } },
      "Paused on a usage limit",
    ],
    [
      { observed: { pullRequests: [], needsYou: [], usageLimitResetAt: at(9) } },
      "Paused on a usage limit",
    ],
    [{ status: "waiting_input" }, "Waiting for you"],
  ] as const)("puts what waits on the person before progress: %j", (overrides, text) => {
    const task = chip("task-1", { ...overrides, summary: "Halfway" } as Partial<ChannelTaskChip>);
    const worker: GoatBotWorkerObservation = {
      shell: { activityRunStatus: "running", pendingRuntimeRequest: null },
      projection: {
        runs: [],
        nodes: [],
        runtimeRequests: [],
        turnItems: [tool("Run tests", null, 9)],
      },
    };
    expect(working(acknowledged(task), worker)?.text).toBe(text);
  });

  it("shows the newer of the task's own update and the dedicated worker's current step", () => {
    const task = chip("task-1", { summary: "Summary" });
    const update: Entry = {
      kind: "bot",
      text: "Checked the first disk",
      taskId: "task-1",
      second: 5,
    };
    const items = acknowledged(task, update);
    const withItems = (...turnItems: ReadonlyArray<ReturnType<typeof tool>>) => ({
      shell: { activityRunStatus: "running" as const, pendingRuntimeRequest: null },
      projection: { runs: [], nodes: [], runtimeRequests: [], turnItems },
    });
    expect(working(items, withItems(tool("Run df -h", null, 6)))?.text).toBe("Run df -h");
    expect(working(items, withItems(tool("Run df -h", null, 4)))?.text).toBe(
      "Checked the first disk",
    );
    expect(working(items, withItems(tool("Read logs", null, 6, "waiting", "subagent")))?.text).toBe(
      "Read logs",
    );
    expect(
      working(acknowledged(task), withItems(tool("Run df -h", null, 6, "completed")))?.text,
    ).toBe("Summary");
    expect(working(acknowledged(task), withItems(tool("  ", null, 6)))?.text).toBe("Summary");
  });

  it("falls back to the dedicated worker's run, then to the task's status", () => {
    const shell = (activityRunStatus: "preparing" | "running" | "waiting") => ({
      shell: { activityRunStatus, pendingRuntimeRequest: null },
      projection: null,
    });
    const task = chip("task-1", { status: "dispatching" });
    expect(working(acknowledged(task), shell("preparing"))?.text).toBe("Starting");
    expect(working(acknowledged(task), shell("waiting"))?.text).toBe("Waiting on other work");
    expect(working(acknowledged(chip("task-1", { status: "received" })))?.text).toBe(
      "Getting ready",
    );
    expect(working(acknowledged(task))?.text).toBe("Starting");
  });

  it("reads a dedicated worker's blocking request but not a background question", () => {
    const task = chip("task-1");
    const request = (
      kind: "command" | "user_input",
      blocking?: boolean,
    ): GoatBotWorkerObservation => ({
      shell: {
        activityRunStatus: "running",
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("request-1"),
          kind,
          createdAt: DateTime.makeUnsafe(at(4)),
          ...(blocking === undefined ? {} : { blocking }),
        },
      },
      projection: null,
    });
    expect(working(acknowledged(task), request("command"))?.text).toBe("Waiting for your approval");
    expect(working(acknowledged(task), request("user_input", false))?.text).toBe("Working");
  });

  it("keeps task A waiting on its child apart from task B running in the same session", () => {
    const taskA = chip("task-a", {
      worker: { environmentId: env, threadId: session, runId: runA },
    });
    const observation = (
      aItems: ReadonlyArray<ReturnType<typeof tool>>,
    ): GoatBotWorkerObservation => ({
      shell: {
        activityRunStatus: "running",
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("request-b"),
          kind: "command",
          createdAt: DateTime.makeUnsafe(at(8)),
        },
      },
      projection: {
        runs: [
          { id: runA, status: "waiting" },
          { id: runB, status: "running" },
        ],
        nodes: [{ id: NodeId.make("node-b"), runId: runB }],
        runtimeRequests: [{ nodeId: NodeId.make("node-b"), kind: "command", status: "pending" }],
        turnItems: [...aItems, tool("Edit files", runB, 8)],
      },
    });
    const items = acknowledged(taskA);
    expect(
      working(items, observation([tool("Check logs", runA, 5, "waiting", "subagent")]))?.text,
    ).toBe("Check logs");
    expect(working(items, observation([]))?.text).toBe("Waiting on other work");
  });

  it("counts a session request only when the request's own run is the task's", () => {
    const taskA = chip("task-a", {
      worker: { environmentId: env, threadId: session, runId: runA },
    });
    const projection = (requestRun: RunId) => ({
      shell: null,
      projection: {
        runs: [{ id: runA, status: "running" as const }],
        nodes: [{ id: NodeId.make("node-1"), runId: requestRun }],
        runtimeRequests: [
          { nodeId: NodeId.make("node-1"), kind: "command" as const, status: "pending" as const },
        ],
        turnItems: [],
      },
    });
    expect(working(acknowledged(taskA), projection(runB))?.text).toBe("Working");
    expect(working(acknowledged(taskA), projection(runA))?.text).toBe("Waiting for your approval");
  });

  it("uses only task observations for a session worker it cannot tie to a run", () => {
    const shell: GoatBotWorkerObservation = {
      shell: {
        activityRunStatus: "waiting",
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("request-b"),
          kind: "command",
          createdAt: DateTime.makeUnsafe(at(8)),
        },
      },
      projection: {
        runs: [{ id: runB, status: "running" }],
        nodes: [],
        runtimeRequests: [],
        turnItems: [tool("Edit files", runB, 8)],
      },
    };
    const noRunId = chip("task-a", {
      status: "dispatching",
      worker: { environmentId: env, threadId: session },
    });
    expect(working(acknowledged(noRunId), shell)?.text).toBe("Starting");
    const notResident = chip("task-a", {
      status: "dispatching",
      worker: { environmentId: env, threadId: session, runId: runA },
    });
    expect(working(acknowledged(notResident), { ...shell, projection: null })?.text).toBe(
      "Starting",
    );
  });

  it("uses only task observations for a remote worker, even beside a local thread with its id", () => {
    const remote = chip("task-1", {
      summary: "Copying files on mac-studio",
      worker: { environmentId: env, threadId: ThreadId.make("worker-task-1"), host: "mac-studio" },
    });
    const local: GoatBotWorkerObservation = {
      shell: { activityRunStatus: "waiting", pendingRuntimeRequest: null },
      projection: {
        runs: [],
        nodes: [],
        runtimeRequests: [],
        turnItems: [tool("Local tool", null, 9)],
      },
    };
    expect(working(acknowledged(remote), local)?.text).toBe("Copying files on mac-studio");
  });

  it("keeps a long step to one short line", () => {
    const task = chip("task-1", { summary: `Line one\n\n  line two ${"x".repeat(200)}` });
    const text = working(acknowledged(task))?.text ?? "";
    expect(text.startsWith("Line one line two x")).toBe(true);
    expect(text).toHaveLength(120);
    expect(text.endsWith("…")).toBe(true);
  });
});

describe("resident atoms", () => {
  afterEach(() => vi.useRealTimers());

  it("reads an atom only while another view keeps it, and never creates it", () => {
    const registry = AtomRegistry.make();
    const atom = Atom.make(1);
    expect(residentAtomValue(registry, atom)).toBeNull();
    expect(observeResidentAtom(registry, atom, () => {})).toBeTypeOf("function");
    expect(registry.getNodes().has(atom)).toBe(false);
    const unmount = registry.mount(atom);
    expect(residentAtomValue(registry, atom)).toBe(1);
    unmount();
  });

  it("hears changes while another view keeps the atom and lets go once that view leaves", () => {
    vi.useFakeTimers();
    const registry = AtomRegistry.make();
    const atom = Atom.make(1);
    const unmount = registry.mount(atom);
    const onChange = vi.fn();
    const release = observeResidentAtom(registry, atom, onChange);
    registry.set(atom, 2);
    expect(onChange).toHaveBeenCalledTimes(1);
    unmount();
    expect(residentAtomValue(registry, atom)).toBeNull();
    vi.advanceTimersByTime(5_000);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(registry.getNodes().get(atom)?.listeners.size ?? 0).toBe(0);
    release();
  });

  it("never lets two readers keep each other's atom alive", () => {
    vi.useFakeTimers();
    const registry = AtomRegistry.make();
    const atom = Atom.make(1);
    const unmount = registry.mount(atom);
    const releaseA = observeResidentAtom(registry, atom, () => {});
    const releaseB = observeResidentAtom(registry, atom, () => {});
    unmount();
    vi.advanceTimersByTime(5_000);
    expect(registry.getNodes().get(atom)?.listeners.size ?? 0).toBe(0);
    releaseA();
    releaseB();
  });
});
