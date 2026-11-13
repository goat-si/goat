import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

type Props = Record<string, unknown> & { children?: ReactNode };
const spoken = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock("react-native", () => ({
  AccessibilityInfo: { announceForAccessibility: (line: string) => spoken.lines.push(line) },
  View: (props: Props) => <div>{props.children}</div>,
  Text: (props: Props) => <span>{props.children}</span>,
  Pressable: (props: Props & { onPress?: () => void }) => (
    <button onClick={props.onPress}>{props.children}</button>
  ),
  TextInput: (props: {
    accessibilityLabel: string;
    value: string;
    onChangeText: (text: string) => void;
  }) => (
    <input
      aria-label={props.accessibilityLabel}
      value={props.value}
      onChange={(event) => props.onChangeText(event.target.value)}
    />
  ),
}));
const net = vi.hoisted(() => ({
  calls: [] as Array<{
    input: { botId: string; query: string; cursor?: string };
    answer: (value: unknown) => Promise<void>;
    fail: (reason: string) => Promise<void>;
  }>,
}));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("../../state/channels", () => ({ channelEnvironment: { searchBotTasks: "search" } }));
vi.mock("@goat/client-runtime/state/runtime", async (importOriginal) => {
  const real = await importOriginal<typeof import("@goat/client-runtime/state/runtime")>();
  return {
    ...real,
    runAtomCommand: (_registry: unknown, _command: unknown, value: { input: never }) =>
      new Promise((resolve) => {
        net.calls.push({
          input: value.input,
          answer: (result) => act(async () => resolve({ _tag: "Success", value: result })),
          fail: (reason) => act(async () => resolve({ _tag: "Failure", cause: reason })),
        });
      }),
    squashAtomCommandFailure: (result: { cause: string }) => ({ reason: result.cause }),
  };
});

import { MobileBotTaskSearch } from "./MobileBotTaskSearch";
import { TASK_SEARCH_DEBOUNCE_MS } from "./useMobileBotTaskSearch";

const container = document.createElement("div");
let root: ReturnType<typeof createRoot> | null = null;
const openTask = vi.fn();
async function setup(botId = "main") {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  net.calls = [];
  spoken.lines = [];
  openTask.mockClear();
  root?.unmount();
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <MobileBotTaskSearch
        environmentId={"env" as never}
        botId={botId as never}
        botName="GOAT Bot"
        onOpenTask={openTask}
      />,
    ),
  );
}
async function type(value: string) {
  const input = container.querySelector("input") as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const wait = (ms: number) => act(async () => void vi.advanceTimersByTime(ms));
const text = () => container.textContent ?? "";
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((item) => item.textContent?.startsWith(label));
const hit = (taskId: string, title: string, titleTruncated?: boolean) => ({
  taskId,
  title,
  createdAt: "2026-11-01T00:00:00.000Z",
  ...(titleTruncated ? { titleTruncated } : {}),
});

it("sends a query only after a quiet moment, one at a time, and keeps the latest query's answer", async () => {
  vi.useFakeTimers();
  try {
    await setup("echo");
    await type("rep");
    await wait(TASK_SEARCH_DEBOUNCE_MS - 1);
    expect(net.calls).toHaveLength(0);
    await type("repo");
    await wait(TASK_SEARCH_DEBOUNCE_MS);
    expect(net.calls.map((call) => call.input)).toEqual([
      { botId: "echo", query: "repo", limit: 20 },
    ]);
    await type("report");
    await wait(TASK_SEARCH_DEBOUNCE_MS);
    expect(net.calls).toHaveLength(1);
    await net.calls[0]?.answer({ tasks: [hit("t0", "Old repo note")] });
    expect(text()).not.toContain("Old repo note");
    expect(net.calls[1]?.input).toEqual({ botId: "echo", query: "report", limit: 20 });
    await net.calls[1]?.answer({ tasks: [hit("t1", "Weekly report", true)] });
    expect(text()).toContain("Weekly report…");
    await act(async () => button("Weekly report…")?.click());
    expect(openTask).toHaveBeenCalledWith("t1", "Weekly report");
  } finally {
    vi.useRealTimers();
  }
});

it("sends nothing for a blank query or one longer than the server takes", async () => {
  vi.useFakeTimers();
  try {
    await setup();
    await type("   ");
    await wait(TASK_SEARCH_DEBOUNCE_MS);
    await type("x".repeat(257));
    await wait(TASK_SEARCH_DEBOUNCE_MS);
    expect(net.calls).toHaveLength(0);
  } finally {
    vi.useRealTimers();
  }
});

it("says no task matches only when the search is complete; an incomplete one shows only its notices", async () => {
  vi.useFakeTimers();
  try {
    await setup();
    await type("report");
    await wait(TASK_SEARCH_DEBOUNCE_MS);
    await net.calls[0]?.answer({ tasks: [], nextCursor: "c1", partial: true });
    expect(text()).not.toContain("No matching tasks.");
    expect(text()).toContain("Some results could not be checked.");
    await act(async () => button("Load more")?.click());
    expect(net.calls[1]?.input).toEqual({
      botId: "main",
      query: "report",
      cursor: "c1",
      limit: 20,
    });
    // The walk ended, but a page could not be checked: it is not a complete "no".
    await net.calls[1]?.answer({ tasks: [] });
    expect(text()).not.toContain("No matching tasks.");
    expect(text()).toContain("Some results could not be checked.");
    expect(button("Load more")).toBeUndefined();
    await type("notes");
    await wait(TASK_SEARCH_DEBOUNCE_MS);
    await net.calls[2]?.answer({ tasks: [], endedEarly: true });
    expect(text()).not.toContain("No matching tasks.");
    expect(text()).toContain("Search ended early.");
    await type("plans");
    await wait(TASK_SEARCH_DEBOUNCE_MS);
    await net.calls[3]?.answer({ tasks: [] });
    expect(text()).toContain("No matching tasks.");
  } finally {
    vi.useRealTimers();
  }
});

it("a walk that stopped early says so and offers no more", async () => {
  vi.useFakeTimers();
  try {
    await setup();
    await type("report");
    await wait(TASK_SEARCH_DEBOUNCE_MS);
    await net.calls[0]?.answer({ tasks: [hit("t1", "Weekly report")], endedEarly: true });
    expect(text()).toContain("Search ended early.");
    expect(button("Load more")).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});

it("a continuation the server rejects restarts once; a failure then offers Try again", async () => {
  vi.useFakeTimers();
  try {
    await setup();
    await type("report");
    await wait(TASK_SEARCH_DEBOUNCE_MS);
    await net.calls[0]?.answer({ tasks: [hit("t1", "Weekly report")], nextCursor: "c1" });
    await act(async () => button("Load more")?.click());
    await net.calls[1]?.fail("invalid_input");
    expect(net.calls[2]?.input).toEqual({ botId: "main", query: "report", limit: 20 });
    await net.calls[2]?.fail("persistence_failed");
    expect(text()).toContain("Couldn't search tasks. Try again");
    await act(async () => button("Couldn't search tasks. Try again")?.click());
    expect(net.calls).toHaveLength(4);
  } finally {
    vi.useRealTimers();
  }
});

it("an answer that arrives after the field is gone lands nowhere", async () => {
  vi.useFakeTimers();
  try {
    await setup();
    await type("report");
    await wait(TASK_SEARCH_DEBOUNCE_MS);
    await act(async () => root?.unmount());
    root = null;
    await net.calls[0]?.answer({ tasks: [hit("t1", "Weekly report")] });
    expect(text()).toBe("");
  } finally {
    vi.useRealTimers();
  }
});

it("a page asked for one bot lands nowhere once the field belongs to another bot", async () => {
  vi.useFakeTimers();
  try {
    await setup("echo");
    await type("report");
    await wait(TASK_SEARCH_DEBOUNCE_MS);
    await act(async () =>
      root?.render(
        <MobileBotTaskSearch
          environmentId={"env" as never}
          botId={"main" as never}
          botName="GOAT Bot"
          onOpenTask={openTask}
        />,
      ),
    );
    await wait(TASK_SEARCH_DEBOUNCE_MS);
    await net.calls[0]?.answer({ tasks: [hit("t-echo", "Echo's report")] });
    expect(text()).not.toContain("Echo's report");
    expect(net.calls[1]?.input).toEqual({ botId: "main", query: "report", limit: 20 });
    await net.calls[1]?.answer({ tasks: [hit("t-main", "Main's report")] });
    expect(text()).toContain("Main's report");
  } finally {
    vi.useRealTimers();
  }
});

it("clearing the field drops a pending answer", async () => {
  vi.useFakeTimers();
  try {
    await setup();
    await type("report");
    await wait(TASK_SEARCH_DEBOUNCE_MS);
    await type("");
    await net.calls[0]?.answer({ tasks: [hit("t1", "Weekly report")] });
    expect(text()).not.toContain("Weekly report");
    expect(net.calls).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});

it("returning to a query the field moved past asks again instead of taking the superseded answer", async () => {
  vi.useFakeTimers();
  try {
    await setup();
    await type("report");
    await wait(TASK_SEARCH_DEBOUNCE_MS);
    await type("notes");
    await type("report");
    await wait(TASK_SEARCH_DEBOUNCE_MS);
    await net.calls[0]?.answer({ tasks: [hit("t-old", "Earlier report")] });
    expect(text()).not.toContain("Earlier report");
    expect(net.calls[1]?.input).toMatchObject({ botId: "main", query: "report" });
    await net.calls[1]?.answer({ tasks: [hit("t-new", "Current report")] });
    expect(text()).toContain("Current report");
  } finally {
    vi.useRealTimers();
  }
});

it("holds at most 50 results: the last page asks only for what is left, then offers no more", async () => {
  vi.useFakeTimers();
  try {
    await setup();
    await type("report");
    await wait(TASK_SEARCH_DEBOUNCE_MS);
    const page = (from: number, count: number) =>
      Array.from({ length: count }, (_, index) =>
        hit(`t${from + index}`, `Report ${from + index}`),
      );
    await net.calls[0]?.answer({ tasks: page(0, 20), nextCursor: "c1" });
    await act(async () => button("Load more")?.click());
    await net.calls[1]?.answer({ tasks: page(20, 20), nextCursor: "c2" });
    await act(async () => button("Load more")?.click());
    expect(net.calls[2]?.input).toEqual({
      botId: "main",
      query: "report",
      cursor: "c2",
      limit: 10,
    });
    await net.calls[2]?.answer({ tasks: page(40, 20), nextCursor: "c3" });
    expect(container.querySelectorAll("button").length).toBe(50);
    expect(text()).not.toContain("Report 50");
    expect(button("Load more")).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});

it("returning to a query that was answered before shows nothing old and waits a quiet moment again", async () => {
  vi.useFakeTimers();
  try {
    await setup();
    await type("report");
    await wait(TASK_SEARCH_DEBOUNCE_MS);
    await net.calls[0]?.answer({ tasks: [hit("t1", "Weekly report")], nextCursor: "c1" });
    expect(text()).toContain("Weekly report");
    await type("notes");
    await type("report");
    expect(text()).not.toContain("Weekly report");
    expect(button("Load more")).toBeUndefined();
    await wait(TASK_SEARCH_DEBOUNCE_MS);
    expect(net.calls[1]?.input).toEqual({ botId: "main", query: "report", limit: 20 });
  } finally {
    vi.useRealTimers();
  }
});

it("counts the query in UTF-8 bytes as the server does: up to 256 is sent, past it nothing and one line", async () => {
  vi.useFakeTimers();
  try {
    await setup();
    const cases: Array<[string, boolean]> = [
      ["a".repeat(256), true],
      ["한".repeat(85), true],
      ["한".repeat(86), false],
      ["😀".repeat(64), true],
      ["😀".repeat(65), false],
    ];
    for (const [query, sent] of cases) {
      const before = net.calls.length;
      await type(query);
      await wait(TASK_SEARCH_DEBOUNCE_MS);
      expect(net.calls.length - before).toBe(sent ? 1 : 0);
      expect(text().includes("Search text is too long for task titles.")).toBe(!sent);
      await net.calls[before]?.answer({ tasks: [] });
    }
  } finally {
    vi.useRealTimers();
  }
});

const many = (from: number, count: number) =>
  Array.from({ length: count }, (_, index) => hit(`t${from + index}`, `Report ${from + index}`));
async function walkTo50(last: { nextCursor?: string; endedEarly?: boolean }) {
  await setup();
  await type("report");
  await wait(TASK_SEARCH_DEBOUNCE_MS);
  await net.calls[0]?.answer({ tasks: many(0, 20), nextCursor: "c1" });
  await act(async () => button("Load more")?.click());
  await net.calls[1]?.answer({ tasks: many(20, 20), nextCursor: "c2" });
  await act(async () => button("Load more")?.click());
  await net.calls[2]?.answer({ tasks: many(40, 10), ...last });
}

it("at 50 hits says only the first 50 are shown when the server had more, and nothing when it had no more", async () => {
  vi.useFakeTimers();
  try {
    await walkTo50({ nextCursor: "c3" });
    expect(text()).toContain("More tasks may exist. Narrow your search.");
    await walkTo50({ endedEarly: true });
    expect(text()).toContain("More tasks may exist. Narrow your search.");
    await walkTo50({});
    expect(text()).not.toContain("More tasks may exist");
    expect(button("Load more")).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});

it("speaks each status once when it changes, and nothing while a page is read", async () => {
  vi.useFakeTimers();
  try {
    await setup();
    await type("report");
    await wait(TASK_SEARCH_DEBOUNCE_MS);
    expect(spoken.lines).toEqual([]);
    await net.calls[0]?.answer({ tasks: [], nextCursor: "c1", partial: true });
    expect(spoken.lines).toEqual(["Some results could not be checked."]);
    await act(async () => button("Load more")?.click());
    await net.calls[1]?.answer({ tasks: [], endedEarly: true, partial: true });
    expect(spoken.lines).toEqual([
      "Some results could not be checked.",
      "Some results could not be checked. Search ended early.",
    ]);
    await type("x".repeat(257));
    expect(spoken.lines.at(-1)).toBe("Search text is too long for task titles.");
    await type("plans");
    await wait(TASK_SEARCH_DEBOUNCE_MS);
    await net.calls[2]?.fail("persistence_failed");
    expect(spoken.lines.at(-1)).toBe("Couldn't search tasks.");
    expect(spoken.lines).toHaveLength(4);
  } finally {
    vi.useRealTimers();
  }
});
