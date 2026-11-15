import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { ChannelInputId, CommandId, ThreadId, type ScheduledTaskRecentRun } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";

type Props = Record<string, unknown> & { children?: ReactNode };
vi.mock("react-native", () => ({
  View: (props: Props & { accessibilityLabel?: string }) => (
    <div aria-label={props.accessibilityLabel}>{props.children}</div>
  ),
  Text: (props: Props) => <span>{props.children}</span>,
  Pressable: (
    props: Props & {
      onPress?: () => void;
      accessibilityLabel?: string;
      accessibilityState?: { expanded?: boolean };
    },
  ) => (
    <button
      onClick={props.onPress}
      aria-label={props.accessibilityLabel}
      aria-expanded={props.accessibilityState?.expanded}
    >
      {props.children}
    </button>
  ),
}));
// Each run's input read: a key per input id, and what the test says that read returns.
const reads = vi.hoisted(() => ({
  keys: [] as Array<string | null>,
  answers: new Map<string, { data: unknown; error: unknown; isPending: boolean }>(),
}));
vi.mock("../../state/channels", () => ({
  channelEnvironment: {
    getInput: (key: { environmentId: string; input: { inputId: string } }) =>
      `input:${key.environmentId}:${key.input.inputId}`,
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (key: string | null) => {
    reads.keys.push(key);
    const answer = key === null ? undefined : reads.answers.get(key);
    return answer ?? { data: null, error: null, isPending: key !== null };
  },
}));

import { MobileRoutineRunStrip } from "./MobileRoutineRunStrip";

const conversation = (input: string) => ({
  threadId: ThreadId.make("bot-thread"),
  inputId: ChannelInputId.make(input),
});
const run = (
  hour: number,
  status: string,
  extra: Partial<ScheduledTaskRecentRun> = {},
): ScheduledTaskRecentRun => ({
  firingId: CommandId.make(`firing-${hour}`),
  status,
  requestedAt: `2026-11-14T${String(hour).padStart(2, "0")}:00:00.000Z`,
  completedAt: null,
  ...extra,
});
type Task = Parameters<typeof MobileRoutineRunStrip>[0]["task"];

function setup() {
  reads.keys = [];
  reads.answers = new Map();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}
async function show(task: Task) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const element = (next: Task) => (
    <MobileRoutineRunStrip
      environmentId={"env" as never}
      task={next}
      title="Morning check"
      botName="Scout"
      formatTime={(iso) => `Nov 14, ${iso.slice(11, 16)}`}
    />
  );
  await act(async () => root.render(element(task)));
  return {
    container,
    rerender: (next: Task) => act(async () => root.render(element(next))),
    dots: () =>
      [...container.querySelectorAll("button")].map((button) => [
        button.getAttribute("aria-label"),
        button.getAttribute("aria-expanded"),
      ]),
    press: (label: string) =>
      act(async () =>
        [...container.querySelectorAll("button")]
          .find((button) => button.getAttribute("aria-label") === label)
          ?.click(),
      ),
    text: () => container.textContent ?? "",
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}
const answer = (inputId: string, data: unknown, error: unknown = null) =>
  reads.answers.set(`input:env:${inputId}`, { data, error, isPending: false });

it("draws a routine's newest seven runs as dots, oldest first, each named by the shared presenter", async () => {
  setup();
  const recentRuns = [
    run(9, "completed", { quiet: true, conversation: conversation("in-9") }),
    run(8, "failed", { dispatchFailed: true }),
    run(7, "running", { conversation: conversation("in-7") }),
    run(6, "completed", { conversation: conversation("in-6") }),
    run(5, "failed", { conversation: conversation("in-5") }),
    run(4, "paused_by_policy"),
    run(3, "cancelled", { conversation: conversation("in-3") }),
    run(2, "completed", { conversation: conversation("in-2") }),
  ];
  const view = await show({ recentRuns });
  expect(
    view.container.querySelector('[aria-label="Recent runs of Morning check"]'),
  ).not.toBeNull();
  expect(view.dots().map(([label]) => label)).toEqual([
    "Run on Nov 14, 03:00, cancelled",
    "Run on Nov 14, 04:00, outcome unavailable",
    "Run on Nov 14, 05:00, failed",
    "Run on Nov 14, 06:00, completed",
    "Run on Nov 14, 07:00, running",
    "Run on Nov 14, 08:00, dispatch failed",
    "Run on Nov 14, 09:00, no update",
  ]);
  await view.unmount();
});

it("draws nothing for a routine whose history was left out or is empty", async () => {
  setup();
  for (const task of [{}, { recentRuns: [] }]) {
    const view = await show(task);
    expect(view.container.innerHTML).toBe("");
    await view.unmount();
  }
});

it("opens each kind of run with the agreed words", async () => {
  setup();
  answer("in-6", { reply: { text: "All quiet on the build." } });
  answer("in-5", { failure: { reason: "provider", message: "The model refused." } });
  answer("in-4", {});
  answer("in-3", null, new Error("offline"));
  const lastRun = { firingId: CommandId.make("firing-9") };
  const recentRuns = [
    run(9, "failed", { dispatchFailed: true }),
    run(8, "failed", { dispatchFailed: true }),
    run(7, "running", { conversation: conversation("in-7") }),
    run(6, "completed", { conversation: conversation("in-6") }),
    run(5, "failed", { conversation: conversation("in-5") }),
    run(4, "completed", { conversation: conversation("in-4") }),
    run(3, "completed", { conversation: conversation("in-3") }),
  ];
  const view = await show({ recentRuns, lastRun, lastRunError: "Scout is paused.\nmore" } as Task);
  const opened = async (label: string) => {
    await view.press(label);
    return view.text();
  };
  expect(await opened("Run on Nov 14, 07:00, running")).toContain("Still running.");
  expect(await opened("Run on Nov 14, 06:00, completed")).toContain("All quiet on the build.");
  expect(await opened("Run on Nov 14, 05:00, failed")).toContain("The model refused.");
  expect(await opened("Run on Nov 14, 04:00, completed")).toContain(
    "Details for this run aren't available.",
  );
  expect(await opened("Run on Nov 14, 03:00, completed")).toContain("Couldn't load this run.");
  expect(await opened("Run on Nov 14, 09:00, dispatch failed")).toContain("Scout is paused.");
  expect(view.text()).not.toContain("more");
  expect(await opened("Run on Nov 14, 08:00, dispatch failed")).toContain(
    "This run didn't reach Scout.",
  );
  // A run the bot took whose link is gone is neither a failure to reach it nor a reply.
  await view.rerender({ recentRuns: [run(2, "completed")] });
  expect(await opened("Run on Nov 14, 02:00, completed")).toContain(
    "Details for this run aren't available.",
  );
  await view.unmount();
});

it("a quiet run says No update and a running one Still running., and neither is read", async () => {
  setup();
  const view = await show({
    recentRuns: [
      run(9, "completed", { quiet: true, conversation: conversation("in-9") }),
      run(8, "running", { conversation: conversation("in-8") }),
    ],
  });
  await view.press("Run on Nov 14, 09:00, no update");
  expect(view.text()).toContain("No update");
  await view.press("Run on Nov 14, 08:00, running");
  expect(view.text()).toContain("Still running.");
  expect(reads.keys.filter((key) => key !== null)).toEqual([]);
  await view.unmount();
});

it("an open run that finishes reads its reply then, and a quiet finish says No update", async () => {
  setup();
  answer("in-8", { reply: { text: "Disks are fine." } });
  const running = { recentRuns: [run(8, "running", { conversation: conversation("in-8") })] };
  const view = await show(running);
  await view.press("Run on Nov 14, 08:00, running");
  expect(view.text()).toContain("Still running.");
  await view.rerender({
    recentRuns: [run(8, "completed", { conversation: conversation("in-8") })],
  });
  expect(view.text()).toContain("Disks are fine.");
  expect(reads.keys).toContain("input:env:in-8");
  await view.unmount();
  setup();
  const quiet = await show(running);
  await quiet.press("Run on Nov 14, 08:00, running");
  await quiet.rerender({
    recentRuns: [run(8, "completed", { quiet: true, conversation: conversation("in-8") })],
  });
  expect(quiet.text()).toContain("No update");
  expect(reads.keys.filter((key) => key !== null)).toEqual([]);
  await quiet.unmount();
});

it("an unknown status without a finish time is not read until the run settles", async () => {
  setup();
  answer("in-8", { reply: { text: "Done at last." } });
  const view = await show({
    recentRuns: [run(8, "paused_by_policy", { conversation: conversation("in-8") })],
  });
  await view.press("Run on Nov 14, 08:00, outcome unavailable");
  expect(view.text()).toContain("Details for this run aren't available.");
  expect(reads.keys.filter((key) => key !== null)).toEqual([]);
  await view.rerender({
    recentRuns: [run(8, "completed", { conversation: conversation("in-8") })],
  });
  expect(view.text()).toContain("Done at last.");
  await view.unmount();
});

it("one run is open at a time: the open dot closes it, another moves it, and a run that leaves the seven closes it", async () => {
  setup();
  const seven = [9, 8, 7, 6, 5, 4, 3].map((hour) =>
    run(hour, "completed", { conversation: conversation(`in-${hour}`) }),
  );
  const view = await show({ recentRuns: seven });
  await view.press("Run on Nov 14, 03:00, completed");
  expect(view.dots().filter(([, expanded]) => expanded === "true")).toEqual([
    ["Run on Nov 14, 03:00, completed", "true"],
  ]);
  await view.press("Run on Nov 14, 04:00, completed");
  expect(view.dots().filter(([, expanded]) => expanded === "true")).toEqual([
    ["Run on Nov 14, 04:00, completed", "true"],
  ]);
  await view.press("Run on Nov 14, 04:00, completed");
  expect(view.dots().filter(([, expanded]) => expanded === "true")).toEqual([]);
  await view.press("Run on Nov 14, 03:00, completed");
  reads.keys = [];
  // A newer firing pushes the open one out of the seven: its panel closes and nothing is read.
  await view.rerender({
    recentRuns: [run(10, "running", { conversation: conversation("in-10") }), ...seven],
  });
  expect(view.dots().filter(([, expanded]) => expanded === "true")).toEqual([]);
  expect(reads.keys.filter((key) => key !== null)).toEqual([]);
  await view.unmount();
});

it("a strip mounted again, as Home's list does when the routines entry scrolls back, starts with no run open", async () => {
  setup();
  const task = { recentRuns: [run(9, "completed", { conversation: conversation("in-9") })] };
  const first = await show(task);
  await first.press("Run on Nov 14, 09:00, completed");
  expect(first.dots()).toEqual([["Run on Nov 14, 09:00, completed", "true"]]);
  await first.unmount();
  const again = await show(task);
  expect(again.dots()).toEqual([["Run on Nov 14, 09:00, completed", "false"]]);
  await again.unmount();
});
