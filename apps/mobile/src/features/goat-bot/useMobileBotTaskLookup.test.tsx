import type { BotWorkResult } from "@goat/contracts";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const net = vi.hoisted(() => ({
  permitted: true,
  calls: [] as Array<{
    input: { taskId: string; botId: string };
    answer: (value: unknown) => Promise<void>;
    fail: (reason: string) => Promise<void>;
    refuse: (error: unknown) => Promise<void>;
  }>,
}));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("../../state/channels", () => ({
  channelEnvironment: { getBotTask: { permissionAtom: () => "lookup-permission" } },
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) => (atom === "lookup-permission" ? net.permitted : false),
}));
vi.mock("@goat/client-runtime/state/runtime", async (importOriginal) => {
  const real = await importOriginal<typeof import("@goat/client-runtime/state/runtime")>();
  return {
    ...real,
    runAtomCommand: (_registry: unknown, _command: unknown, value: { input: never }) =>
      new Promise((resolve) => {
        net.calls.push({
          input: value.input,
          answer: (result) => act(async () => resolve({ _tag: "Success", value: result })),
          fail: (reason) =>
            act(async () =>
              resolve({
                _tag: "Failure",
                cause: { _tag: "Fail", error: { _tag: "ChannelGatewayError", reason } },
              }),
            ),
          refuse: (error) =>
            act(async () => resolve({ _tag: "Failure", cause: { _tag: "Fail", error } })),
        });
      }),
    squashAtomCommandFailure: (result: { cause: { error: unknown } }) => result.cause.error,
  };
});

import {
  taskLookupDecision,
  useMobileBotTaskLookup,
  type MobileTaskLookup,
  type TaskLookupFacts,
} from "./useMobileBotTaskLookup";

type Props = Parameters<typeof useMobileBotTaskLookup>[0];
const seen = { current: null as MobileTaskLookup | null, invalidate: () => {} };
function Probe(props: Props) {
  const value = useMobileBotTaskLookup(props);
  useEffect(() => {
    seen.current = value.lookup;
    seen.invalidate = value.invalidate;
  });
  return null;
}
const at = "2026-11-01T00:00:00.000Z";
const known = (taskId: string, extra: Partial<BotWorkResult> = {}): BotWorkResult =>
  ({
    task: {
      state: "known",
      row: {
        kind: "task",
        task: { taskId, title: `Task ${taskId}`, status: "completed", updatedAt: at },
        view: { taskId, pinnedAt: null, doneAt: null, readThrough: null },
        lastActivityAt: at,
        unread: false,
        mainMessagesSinceQuiet: 0,
        worker: { environmentId: "env", threadId: "w-1" },
      },
    },
    codingRows: [],
    remoteWork: [],
    launchesTruncated: false,
    partial: false,
    ...extra,
  }) as unknown as BotWorkResult;

const container = document.createElement("div");
let root: ReturnType<typeof createRoot> | null = null;
function setup() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  net.calls = [];
  net.permitted = true;
  seen.current = null;
  root?.unmount();
  root = createRoot(container);
}
const base: Props = {
  environmentId: "env" as Props["environmentId"],
  botId: "main" as Props["botId"],
  taskId: "t1" as Props["taskId"],
  supported: true,
  established: true,
  refreshing: false,
  holdsTask: false,
  childGroups: [],
};
async function show(props: Partial<Props> = {}) {
  await act(async () => root?.render(<Probe {...base} {...props} />));
}
const state = () => seen.current?.state;
const asked = () => net.calls.map((call) => call.input.taskId);

it("decides the view and whether a read starts from one set of facts", () => {
  const facts: TaskLookupFacts = {
    able: true,
    permitted: true,
    established: true,
    refreshing: false,
    holdsTask: false,
    held: false,
    stale: false,
    inFlight: false,
  };
  const decide = (change: Partial<TaskLookupFacts>) => taskLookupDecision({ ...facts, ...change });
  expect(decide({})).toEqual({ view: "loading", read: true });
  expect(decide({ established: false })).toEqual({ view: "off", read: false });
  expect(decide({ able: false })).toEqual({ view: "off", read: false });
  expect(decide({ holdsTask: true, held: true, stale: true })).toEqual({
    view: "row",
    read: false,
  });
  expect(decide({ permitted: false })).toEqual({ view: "denied", read: false });
  expect(decide({ refreshing: true })).toEqual({ view: "loading", read: false });
  expect(decide({ inFlight: true })).toEqual({ view: "loading", read: false });
  expect(decide({ held: true })).toEqual({ view: "answer", read: false });
  expect(decide({ held: true, stale: true })).toEqual({ view: "answer", read: true });
  expect(decide({ held: true, stale: true, refreshing: true })).toEqual({
    view: "answer",
    read: false,
  });
  // A held failure is an answer: no read by itself, and Try again or a stale mark reads again.
  expect(decide({ held: true, inFlight: true })).toEqual({ view: "answer", read: false });
});

it("asks nothing before a list settles, when it holds the task, without the lookup, or without permission", async () => {
  setup();
  await show({ established: false });
  expect(state()).toBe("off");
  await show({ holdsTask: true });
  expect(state()).toBe("off");
  await show({ supported: false });
  expect(state()).toBe("off");
  net.permitted = false;
  await show();
  expect(state()).toBe("denied");
  expect(net.calls).toHaveLength(0);
});

it("reads the task by id for the bot it belongs to and shows it as known", async () => {
  setup();
  await show({ botId: "echo" as Props["botId"] });
  expect(state()).toBe("loading");
  expect(net.calls[0]?.input).toEqual({ taskId: "t1", botId: "echo" });
  await net.calls[0]?.answer(known("t1"));
  const value = seen.current;
  expect(value?.state).toBe("known");
  if (value?.state !== "known") return;
  expect(value.task.row.task.title).toBe("Task t1");
  expect(value.task.threads).toEqual([{ environmentId: "env", threadId: "w-1" }]);
});

it("passes an unavailable view through without inventing one", async () => {
  setup();
  await show();
  await net.calls[0]?.answer({
    task: {
      state: "unavailable",
      task: { taskId: "t1", title: "Task t1", status: "failed", updatedAt: at },
    },
    codingRows: [],
    remoteWork: [],
    launchesTruncated: true,
    partial: true,
  });
  const value = seen.current;
  expect(value?.state).toBe("unavailable");
  if (value?.state !== "unavailable") return;
  expect(value.result.launchesTruncated).toBe(true);
  expect("view" in value.task).toBe(false);
});

it("says a task is missing on not_found; a failure waits for Try again, which reads once", async () => {
  setup();
  await show();
  await net.calls[0]?.fail("not_found");
  expect(state()).toBe("missing");
  setup();
  await show();
  await net.calls[0]?.fail("persistence_failed");
  await show();
  expect(net.calls).toHaveLength(1);
  const failed = seen.current;
  expect(failed?.state).toBe("failed");
  if (failed?.state !== "failed") return;
  await act(async () => {
    failed.retry();
    failed.retry();
  });
  expect(net.calls).toHaveLength(2);
  await net.calls[1]?.answer(known("t1"));
  expect(state()).toBe("known");
});

it("a read the server refuses for this device's access says so instead of offering a retry", async () => {
  setup();
  await show();
  await net.calls[0]?.refuse({ _tag: "EnvironmentAuthorizationError", message: "no" });
  expect(state()).toBe("denied");
  await show({ taskId: "t2" as Props["taskId"] });
  await net.calls[1]?.fail("forbidden");
  expect(state()).toBe("denied");
});

it("only the newest read answers: a task left behind lands nowhere", async () => {
  setup();
  await show();
  await show({ taskId: "t2" as Props["taskId"] });
  expect(asked()).toEqual(["t1", "t2"]);
  await net.calls[0]?.answer(known("t1"));
  expect(state()).toBe("loading");
  await net.calls[1]?.answer(known("t2"));
  expect(seen.current?.state === "known" && seen.current.task.row.task.taskId).toBe("t2");
});

it("a task change during a refresh waits for it; a refresh that returns the task reads nothing", async () => {
  setup();
  await show();
  await net.calls[0]?.answer(known("t1"));
  await show({ taskId: "t2" as Props["taskId"], refreshing: true });
  expect(asked()).toEqual(["t1"]);
  await show({ taskId: "t2" as Props["taskId"], holdsTask: true });
  expect(asked()).toEqual(["t1"]);
  await show({ taskId: "t2" as Props["taskId"] });
  expect(asked()).toEqual(["t1", "t2"]);
});

it("an answer stays through a refresh, also a failed one, and is read again only once it is stale", async () => {
  setup();
  await show();
  await net.calls[0]?.answer(known("t1"));
  await show({ refreshing: true });
  expect(state()).toBe("known");
  await show();
  expect(net.calls).toHaveLength(1);
  // An action rereads the list and marks the task stale in one update.
  await act(async () => {
    seen.invalidate();
    root?.render(<Probe {...base} refreshing />);
  });
  expect(net.calls).toHaveLength(1);
  expect(state()).toBe("known");
  await show();
  expect(net.calls).toHaveLength(2);
  await show();
  expect(net.calls).toHaveLength(2);
});

it("a stale mark for a task the screen left is dropped", async () => {
  setup();
  await show();
  await net.calls[0]?.answer(known("t1"));
  await act(async () => {
    seen.invalidate();
    root?.render(<Probe {...base} taskId={"t2" as Props["taskId"]} refreshing />);
  });
  await show({ taskId: "t2" as Props["taskId"], holdsTask: true });
  await show({ holdsTask: true });
  await show();
  // Back on t1 after the list held it: its answer was dropped, so it reads again, once.
  expect(asked()).toEqual(["t1", "t1"]);
});

it("a read ends with its period: after A -> B (listed) -> A its late answer is ignored and one new read serves A", async () => {
  setup();
  await show();
  await show({ taskId: "t2" as Props["taskId"], holdsTask: true });
  await show();
  expect(asked()).toEqual(["t1", "t1"]);
  await net.calls[0]?.answer(known("t1", { partial: true }));
  expect(state()).toBe("loading");
  await net.calls[1]?.answer(known("t1"));
  expect(seen.current?.state === "known" && seen.current.result.partial).toBe(false);
});

it("a task that enters and leaves the current list while its read is out is read again, and the late answer is ignored", async () => {
  setup();
  await show();
  await show({ holdsTask: true });
  await show();
  expect(asked()).toEqual(["t1", "t1"]);
  await net.calls[0]?.answer(known("t1", { partial: true }));
  expect(state()).toBe("loading");
});

it("a capability withdrawn while a read is out shows the screen without lookup, and its answer does not count later", async () => {
  setup();
  await show();
  await show({ supported: false });
  expect(state()).toBe("off");
  await net.calls[0]?.answer(known("t1"));
  expect(state()).toBe("off");
  await show();
  expect(asked()).toEqual(["t1", "t1"]);
  expect(state()).toBe("loading");
});

it("an answer that arrives after the screen unmounted sets nothing", async () => {
  setup();
  await show();
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  await act(async () => root?.unmount());
  root = null;
  await net.calls[0]?.answer(known("t1"));
  expect(errors).not.toHaveBeenCalled();
  errors.mockRestore();
});

it("read permission withdrawn while a read is out shows the permission line, and its answer does not count later", async () => {
  setup();
  await show();
  net.permitted = false;
  await show();
  expect(state()).toBe("denied");
  await net.calls[0]?.answer(known("t1"));
  net.permitted = true;
  await show();
  expect(asked()).toEqual(["t1", "t1"]);
  expect(state()).toBe("loading");
});

it("an answer belongs to its period: after the capability goes and returns, the task is read again", async () => {
  setup();
  await show();
  await net.calls[0]?.answer(known("t1"));
  expect(state()).toBe("known");
  await show({ supported: false });
  expect(state()).toBe("off");
  await show();
  expect(asked()).toEqual(["t1", "t1"]);
  expect(state()).toBe("loading");
});

it("a held answer is forgotten when the screen moves to another task, and coming back reads it again", async () => {
  setup();
  await show();
  await net.calls[0]?.answer(known("t1"));
  expect(state()).toBe("known");
  await show({ taskId: "t2" as Props["taskId"] });
  expect(state()).toBe("loading");
  expect(asked()).toEqual(["t1", "t2"]);
  await net.calls[1]?.answer(known("t2"));
  await show();
  expect(state()).toBe("loading");
  expect(asked()).toEqual(["t1", "t2", "t1"]);
});
