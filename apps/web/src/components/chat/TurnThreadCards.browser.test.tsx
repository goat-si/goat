import { RunId } from "@goat/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { callTimelineEntry } from "./goatThreadCalls.fixtures";
import { ENVIRONMENT_ID, click, message, renderTimeline } from "./MessagesTimeline.browserHarness";

const RUN = "run-cards";
const shells = vi.hoisted(() => new Map<string, unknown>());
vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useQuietThreadShell: ((
    ref: { readonly environmentId: string; readonly threadId: string } | null,
  ) => (ref && shells.get(`${ref.environmentId}/${ref.threadId}`)) ?? null) as never,
}));

function shell(
  title: string,
  state: {
    readonly runtime?: string;
    readonly run?: string;
    readonly input?: boolean;
    readonly deleted?: boolean;
    readonly subagentRequest?: boolean;
    readonly backgroundWork?: boolean;
  },
) {
  return {
    title,
    deletedAt: state.deleted ? "2026-10-27T00:00:00.000Z" : null,
    hasPendingApprovals: false,
    hasPendingUserInput: state.input ?? false,
    pendingSubagentRequest: state.subagentRequest ? "approval" : null,
    pendingBackgroundTasks: state.backgroundWork
      ? [{ kind: "subagent", id: "child", startedAt: "2026-10-27T00:00:00.000Z" }]
      : [],
    runtime: state.runtime === undefined ? null : { status: state.runtime },
    latestRun: state.run === undefined ? null : { status: state.run },
  };
}

function setup(entries: ReadonlyArray<readonly [string, ReturnType<typeof shell>]>) {
  shells.clear();
  for (const [id, value] of entries) shells.set(`${ENVIRONMENT_ID}/${id}`, value);
}

const launch = (threadId: string, title: string) =>
  callTimelineEntry(
    "goat_thread_launch",
    { title },
    { threadId },
    "completed",
    `launch-${threadId}`,
    "thread-sender",
    RUN,
  );
const answer = message(
  "Lanes are running",
  { role: "assistant", runId: RunId.make(RUN) },
  "answer",
);

describe("turn thread cards", () => {
  it("shows each launched thread with its live status and opens it", async () => {
    setup([
      ["lane-1", shell("Lane 1", { runtime: "running" })],
      ["lane-2", shell("Lane 2", { input: true })],
      ["lane-3", shell("Lane 3", { run: "failed" })],
    ]);
    const onOpenThread = vi.fn();
    await using screen = await renderTimeline(
      [launch("lane-1", "Lane 1"), launch("lane-2", "Lane 2"), launch("lane-3", "Lane 3"), answer],
      { onOpenThread },
    );
    expect(screen.buttons("Open Lane 1, Working")).toHaveLength(1);
    expect(screen.buttons("Open Lane 2, Waiting")).toHaveLength(1);
    await click(screen.button("Open Lane 3, Failed"));
    expect(onOpenThread).toHaveBeenCalledWith("lane-3");
  });

  it("keeps a thread waiting on its children or their requests out of Done", async () => {
    setup([
      ["lane-1", shell("Lane 1", { runtime: "idle", run: "completed", backgroundWork: true })],
      ["lane-2", shell("Lane 2", { runtime: "idle", run: "completed", subagentRequest: true })],
    ]);
    await using screen = await renderTimeline([
      launch("lane-1", "Lane 1"),
      launch("lane-2", "Lane 2"),
      answer,
    ]);
    expect(screen.buttons("Open Lane 1, Working")).toHaveLength(1);
    expect(screen.buttons("Open Lane 2, Waiting")).toHaveLength(1);
  });

  it("shows three cards and the rest behind +N more", async () => {
    setup(
      [1, 2, 3, 4, 5].map((n) => [`lane-${n}`, shell(`Lane ${n}`, { run: "completed" })] as const),
    );
    await using screen = await renderTimeline([
      ...[1, 2, 3, 4, 5].map((n) => launch(`lane-${n}`, `Lane ${n}`)),
      answer,
    ]);
    expect(screen.buttons(/^Open Lane/)).toHaveLength(3);
    await click(screen.button("+2 more"));
    expect(screen.buttons(/^Open Lane/)).toHaveLength(5);
  });

  it("names a thread on another machine without opening it", async () => {
    setup([]);
    await using screen = await renderTimeline([
      callTimelineEntry(
        "goat_ssh_thread_launch",
        { host: "mini", title: "Remote lane" },
        { host: "mini", threadId: "lane-r" },
        "completed",
        "ssh",
        "thread-sender",
        RUN,
      ),
      answer,
    ]);
    expect(screen.text()).toContain("Remote lane");
    expect(screen.text()).toContain("On mini");
    expect(screen.buttons(/^Open Remote lane/)).toHaveLength(0);
  });
});
