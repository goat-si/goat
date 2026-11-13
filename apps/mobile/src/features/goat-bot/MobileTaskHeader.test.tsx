import type { BotWorkTask } from "@goat/client-runtime/goatBot";
import type { BotWorkResult } from "@goat/contracts";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

type Props = Record<string, unknown> & { children?: ReactNode };
const spoken = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock("react-native", () => ({
  AccessibilityInfo: { announceForAccessibility: (line: string) => spoken.lines.push(line) },
  View: (props: Props) => <div>{props.children}</div>,
  Text: (props: Props) => <span>{props.children}</span>,
  Pressable: (props: Props & { onPress?: () => void; disabled?: boolean }) => (
    <button onClick={props.onPress} disabled={props.disabled}>
      {props.children}
    </button>
  ),
}));
vi.mock("./GoatBotTaskRow", () => ({ GoatBotTaskRow: () => <span>chat card</span> }));
vi.mock("./MobileTaskRetry", () => ({ MobileTaskRetry: () => <button>Retry</button> }));
vi.mock("./MobileBotRemoteWork", () => ({
  MobileBotRemoteWork: () => <button>Remote work</button>,
}));

import { MobileTaskHeader } from "./MobileTaskHeader";
import type { MobileTaskLookup } from "./useMobileBotTaskLookup";

const at = "2026-11-01T00:00:00.000Z";
const row = {
  kind: "task",
  task: {
    taskId: "t1",
    title: "Old report",
    status: "completed",
    updatedAt: at,
    titleTruncated: true,
  },
  view: { taskId: "t1", pinnedAt: null, doneAt: null, readThrough: null },
  lastActivityAt: at,
  unread: false,
  mainMessagesSinceQuiet: 0,
} as const;
const result = (task: BotWorkResult["task"], extra: Partial<BotWorkResult> = {}) =>
  ({
    task,
    codingRows: [],
    remoteWork: [],
    launchesTruncated: false,
    partial: false,
    ...extra,
  }) as BotWorkResult;
const knownTask = {
  row,
  subagents: [],
  threads: [{ environmentId: "env", threadId: "w-1" }],
  remote: [],
} as unknown as BotWorkTask;

const container = document.createElement("div");
const retry = vi.fn();
const openHome = vi.fn();
async function render(lookup: MobileTaskLookup, enabled = true, card: unknown = null) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <MobileTaskHeader
        task={undefined}
        screen={{ lookup, canUpdate: true, update: async () => true, retried: () => {} }}
        title="Old report"
        botName="GOAT Bot"
        environmentId={"env" as never}
        enabled={enabled}
        canRetry
        older
        loading={false}
        failed={false}
        childError={false}
        onRetryRead={() => {}}
        onOpenThread={() => {}}
        onOpenHome={openHome}
        card={card as never}
      />,
    ),
  );
  return root;
}
const text = () => container.textContent ?? "";
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((item) => item.textContent === label);

it("a looked-up task shows its status and actions instead of the older-work explanation", async () => {
  const root = await render({
    state: "known",
    task: knownTask,
    result: result({ state: "known", row } as never, { launchesTruncated: true, partial: true }),
  });
  expect(text()).toContain("Old report…");
  expect(text()).toContain("Done");
  expect(button("Pin")).toBeDefined();
  expect(button("Open work thread")).toBeDefined();
  expect(text()).toContain("More of this task's work isn't shown here.");
  expect(text()).toContain("Some task details could not be checked.");
  expect(text()).not.toContain("Status and actions for older work");
  await act(async () => root.unmount());
});

it("an unavailable task shows its status and work but nothing that needs its read, pinned or done state", async () => {
  const root = await render({
    state: "unavailable",
    task: {
      state: "unavailable",
      task: { taskId: "t1", title: "Old report", status: "failed", updatedAt: at },
      worker: { environmentId: "env", threadId: "w-1" },
    } as never,
    result: result({ state: "unavailable" } as never, { launchesTruncated: true, partial: true }),
  });
  expect(text()).toContain("Failed");
  expect(text()).toContain("Its read, pinned and done state couldn't be read.");
  expect(button("Pin")).toBeUndefined();
  expect(button("Mark done")).toBeUndefined();
  expect(button("Retry")).toBeDefined();
  expect(button("Open work thread")).toBeDefined();
  expect(text()).toContain("More of this task's work isn't shown here.");
  expect(text()).toContain("Some task details could not be checked.");
  await act(async () => root.unmount());
});

it("a task the server does not have says so once, with no way to Home", async () => {
  const root = await render({ state: "missing" });
  expect(text()).toContain("This task cannot be found here.");
  expect(button("Open Home")).toBeUndefined();
  await act(async () => root.unmount());
});

it("a failed lookup keeps the explanation and offers Try again", async () => {
  retry.mockClear();
  const root = await render({ state: "failed", retry });
  expect(text()).toContain("Status and actions for older work are in GOAT Bot's Home.");
  await act(async () => button("Couldn't load this task. Try again")?.click());
  expect(retry).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
});

it("without the lookup, or without permission, the older-work explanation stays as before", async () => {
  let root = await render({ state: "off" });
  expect(text()).toContain("Status and actions for older work are in GOAT Bot's Home.");
  expect(button("Open Home")).toBeDefined();
  await act(async () => root.unmount());
  root = await render({ state: "denied" });
  expect(text()).toContain("Permission to read this task is unavailable.");
  expect(button("Open Home")).toBeDefined();
  await act(async () => root.unmount());
});

it("a task the server does not have shows no chat card, so nothing on the screen opens it", async () => {
  const root = await render({ state: "missing" }, true, {
    key: "t1",
    revision: 1,
    updatedAt: at,
    title: "Old report",
    statusLabel: "Done",
    target: { kind: "thread", threadId: "w-1" },
  });
  expect(text()).toContain("This task cannot be found here.");
  expect(text()).not.toContain("chat card");
  await act(async () => root.unmount());
});

it("tells the screen reader once when the lookup settles on a failure, a refusal or partial details", async () => {
  spoken.lines = [];
  const root = await render({ state: "loading" });
  expect(spoken.lines).toEqual([]);
  const next = async (lookup: MobileTaskLookup) =>
    act(async () =>
      root.render(
        <MobileTaskHeader
          task={undefined}
          screen={{ lookup, canUpdate: true, update: async () => true, retried: () => {} }}
          title="Old report"
          botName="GOAT Bot"
          environmentId={"env" as never}
          enabled
          canRetry
          older
          loading={false}
          failed={false}
          childError={false}
          onRetryRead={() => {}}
          onOpenThread={() => {}}
          onOpenHome={openHome}
          card={null}
        />,
      ),
    );
  await next({ state: "failed", retry });
  await next({ state: "failed", retry });
  await next({ state: "denied" });
  await next({
    state: "known",
    task: knownTask,
    result: result({ state: "known", row } as never, { partial: true }),
  });
  expect(spoken.lines).toEqual([
    "Couldn't load this task.",
    "Permission to read this task is unavailable.",
    "Some task details could not be checked.",
  ]);
  await act(async () => root.unmount());
});
