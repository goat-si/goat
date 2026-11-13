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

import { useMobileBotTaskLookup, type MobileTaskLookup } from "./useMobileBotTaskLookup";

type Props = Parameters<typeof useMobileBotTaskLookup>[0];
const seen = { current: null as MobileTaskLookup | null };
function Probe(props: Props) {
  const value = useMobileBotTaskLookup(props);
  useEffect(() => {
    seen.current = value;
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
  needed: true,
  supported: true,
  childGroups: [],
};
async function show(props: Partial<Props> = {}) {
  await act(async () => root?.render(<Probe {...base} {...props} />));
}
const state = () => seen.current?.state;

it("asks nothing when the list holds the task, the server cannot look up, or the device may not read", async () => {
  setup();
  await show({ needed: false });
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

it("says a task is missing on not_found, and a failure can be read again", async () => {
  setup();
  await show();
  await net.calls[0]?.fail("not_found");
  expect(state()).toBe("missing");
  setup();
  await show();
  await net.calls[0]?.fail("persistence_failed");
  const failed = seen.current;
  expect(failed?.state).toBe("failed");
  if (failed?.state !== "failed") return;
  await act(async () => failed.reload());
  expect(net.calls).toHaveLength(2);
  await net.calls[1]?.answer(known("t1"));
  expect(state()).toBe("known");
});

it("keeps only the newest read: a late answer for another task or an earlier read lands nowhere", async () => {
  setup();
  await show();
  await show({ taskId: "t2" as Props["taskId"] });
  await net.calls[0]?.answer(known("t1"));
  expect(state()).toBe("loading");
  await net.calls[1]?.answer(known("t2"));
  const value = seen.current;
  expect(value?.state === "known" && value.task.row.task.taskId).toBe("t2");
  if (value?.state !== "known") return;
  await act(async () => value.reload());
  await act(async () => (seen.current as { reload: () => void }).reload());
  await net.calls[3]?.answer(known("t2", { partial: true }));
  await net.calls[2]?.answer(known("t2"));
  expect((seen.current as { result: BotWorkResult }).result.partial).toBe(true);
});

it("a reload kept by an earlier task's screen does not displace the task shown now", async () => {
  setup();
  await show();
  await net.calls[0]?.answer(known("t1"));
  const earlier = seen.current;
  await show({ taskId: "t2" as Props["taskId"] });
  if (earlier?.state === "known") earlier.reload();
  expect(net.calls.map((call) => call.input.taskId)).toEqual(["t1", "t2"]);
  await net.calls[1]?.answer(known("t2"));
  expect(state()).toBe("known");
  expect(seen.current?.state === "known" && seen.current.task.row.task.taskId).toBe("t2");
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

it("a reload kept from before the lookup stopped asking sends nothing", async () => {
  setup();
  await show();
  await net.calls[0]?.answer(known("t1"));
  const earlier = seen.current;
  await show({ supported: false });
  if (earlier?.state === "known") earlier.reload();
  await show({ needed: false });
  if (earlier?.state === "known") earlier.reload();
  await act(async () => root?.unmount());
  root = null;
  if (earlier?.state === "known") earlier.reload();
  expect(net.calls).toHaveLength(1);
});

it("after leaving a task and coming back, an earlier reload rereads that same task and its answer lands", async () => {
  setup();
  await show();
  await net.calls[0]?.answer(known("t1"));
  const earlier = seen.current;
  await show({ taskId: "t2" as Props["taskId"] });
  await show();
  if (earlier?.state === "known") earlier.reload();
  expect(net.calls.map((call) => call.input.taskId)).toEqual(["t1", "t2", "t1", "t1"]);
  await net.calls[3]?.answer(known("t1"));
  expect(state()).toBe("known");
});

it("Try again pressed twice before the screen shows it loading reads once", async () => {
  setup();
  await show();
  await net.calls[0]?.fail("persistence_failed");
  const failed = seen.current;
  expect(failed?.state).toBe("failed");
  await act(async () => {
    if (failed?.state === "failed") {
      failed.reload();
      failed.reload();
    }
  });
  expect(net.calls).toHaveLength(2);
});
