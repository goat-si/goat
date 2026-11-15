import type { BotRoutineSource } from "@goat/client-runtime/scheduledTasks";
import {
  ChannelInputId,
  CommandId,
  EnvironmentAuthorizationError,
  EnvironmentId,
  ScheduledTaskId,
  ThreadId,
  type ScheduledTaskRecentRun,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";
import { render } from "../../../test/render";

const mocks = vi.hoisted(() => ({ upsert: vi.fn(), setEnabled: vi.fn(), runNow: vi.fn() }));
// Each run's input read: every key asked for, in render order, and what a key's read answers.
const reads = vi.hoisted(() => ({
  keys: [] as Array<string | null>,
  answers: new Map<string, { data: unknown; error: string | null }>(),
  timestampFormat: "24-hour" as "locale" | "12-hour" | "24-hour",
}));
vi.mock("~/state/entities", () => ({
  useThreadShell: () => ({
    id: "bot",
    projectId: "bot-project",
    modelSelection: { instanceId: "codex", model: "gpt-5" },
  }),
}));
vi.mock("~/state/server", () => ({
  serverEnvironment: {
    upsertScheduledTask: { permissionAtom: () => Atom.make(true), execute: mocks.upsert },
    setScheduledTaskEnabled: { permissionAtom: () => Atom.make(true), execute: mocks.setEnabled },
    runScheduledTaskNow: { permissionAtom: () => Atom.make(true), execute: mocks.runNow },
  },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: { execute: typeof mocks.upsert }) => command.execute,
}));
vi.mock("~/state/channels", () => ({
  channelEnvironment: {
    getInput: (key: { environmentId: string; input: { inputId: string } }) =>
      `input:${key.environmentId}:${key.input.inputId}`,
  },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (key: string | null) => {
    reads.keys.push(key);
    const answer = key === null ? undefined : reads.answers.get(key);
    return {
      data: answer?.data ?? null,
      error: answer?.error ?? null,
      failure: null,
      isPending: key !== null && answer === undefined,
      isSuccess: answer !== undefined && answer.error === null,
      dataUpdatedAt: 0,
      refresh: () => {},
    };
  },
}));
vi.mock("~/hooks/useSettings", () => ({
  usePrimarySettings: <T,>(select: (settings: { timestampFormat: string }) => T) =>
    select({ timestampFormat: reads.timestampFormat }),
}));
// Run times read the same in any runner: English months and AM/PM.
vi.mock("~/timestampFormat", async (original) => ({
  ...(await original<typeof import("~/timestampFormat")>()),
  timestampLocale: "en-US",
}));
import { GoatBotRoutines } from "./GoatBotRoutines";
import { GoatBotChatHidden } from "./goatBotLayout";
import { navigationBlocked } from "~/lib/navigationHolds";

const environmentId = EnvironmentId.make("env");
const threadId = ThreadId.make("bot");

function setup() {
  mocks.upsert.mockReset();
  mocks.setEnabled.mockReset();
  mocks.runNow.mockReset();
  reads.keys = [];
  reads.answers = new Map();
  reads.timestampFormat = "24-hour";
}

const savedCheckIn: BotRoutineSource = {
  id: ScheduledTaskId.make("goat-bot-check-in:bot"),
  title: "Check in",
  prompt: "Look over my open work",
  enabled: true,
  schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] },
  threadId,
  nextRunAt: null,
  lastRunAt: null,
  lastRunStatus: "never",
  lastRunError: null,
};

it("Check in on me saves a weekday-morning routine in the bot's chat, then stops offering", async () => {
  setup();
  mocks.upsert.mockResolvedValue(AsyncResult.success({ task: savedCheckIn }));
  await using screen = await render(
    <GoatBotRoutines
      environmentId={environmentId}
      threadId={threadId}
      tasks={[]}
      error={null}
      onRetry={() => {}}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Check in on me" }));
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(mocks.upsert).toHaveBeenCalledWith({
    environmentId,
    input: expect.objectContaining({
      title: "Check in",
      threadId: "bot",
      projectId: "bot-project",
      notificationPolicy: "important_updates",
      schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] },
      creationSource: "web",
    }),
  });
  await expect
    .element(screen.getByRole("form", { name: "Check in on me" }))
    .not.toBeInTheDocument();
  await screen.rerender(
    <GoatBotRoutines
      environmentId={environmentId}
      threadId={threadId}
      tasks={[savedCheckIn]}
      error={null}
      onRetry={() => {}}
    />,
  );
  await expect.element(screen.getByText("Weekdays at 09:00 · Not scheduled")).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Check in on me" }))
    .not.toBeInTheDocument();
});

it("the check-in form holds back a New bot open while it is open", async () => {
  setup();
  await using screen = await render(
    <GoatBotRoutines
      environmentId={environmentId}
      threadId={threadId}
      tasks={[]}
      error={null}
      onRetry={() => {}}
    />,
  );
  expect(navigationBlocked()).toBe(false);
  await userEvent.click(screen.getByRole("button", { name: "Check in on me" }));
  await expect.element(screen.getByRole("form", { name: "Check in on me" })).toBeVisible();
  expect(navigationBlocked()).toBe(true);
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(navigationBlocked()).toBe(false);
});

it("a refused save keeps the check-in form open and shows why", async () => {
  setup();
  mocks.upsert.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("Denied"))));
  await using screen = await render(
    <GoatBotRoutines
      environmentId={environmentId}
      threadId={threadId}
      tasks={[]}
      error={null}
      onRetry={() => {}}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Check in on me" }));
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("Couldn't save the check-in: Denied");
  await expect.element(screen.getByRole("form", { name: "Check in on me" })).toBeVisible();
});

const failedRoutine: BotRoutineSource = {
  ...savedCheckIn,
  id: ScheduledTaskId.make("routine:failed"),
  title: "Morning digest",
  lastRunAt: "2026-11-07T08:00:00.000Z",
  lastRunStatus: "failed",
  lastRunError: "Provider exited with code 1",
};
const fineRoutine: BotRoutineSource = {
  ...savedCheckIn,
  id: ScheduledTaskId.make("routine:fine"),
  title: "Evening digest",
  lastRunAt: "2026-11-07T08:00:00.000Z",
  lastRunStatus: "succeeded",
};

it("offers Run now only for a routine whose last run failed, one run per tap", async () => {
  setup();
  mocks.runNow.mockResolvedValue(AsyncResult.success({ task: failedRoutine }));
  await using screen = await render(
    <GoatBotRoutines
      environmentId={environmentId}
      threadId={threadId}
      tasks={[failedRoutine, fineRoutine]}
      error={null}
      onRetry={() => {}}
    />,
  );
  const runNow = screen.getByRole("button", { name: "Run now" });
  await expect.element(runNow).toBeVisible();
  expect(screen.getByRole("button", { name: "Run now" }).elements()).toHaveLength(1);
  await userEvent.click(runNow);
  await vi.waitFor(() => expect(mocks.runNow).toHaveBeenCalledOnce());
  expect(mocks.runNow).toHaveBeenCalledWith({
    environmentId,
    input: { id: "routine:failed" },
  });
});

it("a refused Run now says why", async () => {
  setup();
  mocks.runNow.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("Busy"))));
  await using screen = await render(
    <GoatBotRoutines
      environmentId={environmentId}
      threadId={threadId}
      tasks={[failedRoutine]}
      error={null}
      onRetry={() => {}}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Run now" }));
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("Couldn't run this routine: Busy");
});

it("explains denied and offline routine reads without offering retry", async () => {
  setup();
  const denied = new EnvironmentAuthorizationError({
    message: "no",
    requiredScope: "orchestration:read",
  });
  await using screen = await render(
    <GoatBotRoutines
      environmentId={environmentId}
      threadId={threadId}
      tasks={null}
      error="denied"
      failure={denied}
      onRetry={() => {}}
    />,
  );
  await expect
    .element(screen.getByText("This device can't read GOAT Bot's routines."))
    .toBeVisible();
  expect(screen.getByRole("button", { name: "Try again" }).query()).toBeNull();
});

it("explains offline routine reads without offering retry", async () => {
  setup();
  await using screen = await render(
    <GoatBotRoutines
      environmentId={environmentId}
      threadId={threadId}
      tasks={null}
      error="offline"
      offline
      onRetry={() => {}}
    />,
  );
  await expect
    .element(screen.getByText("Routines are unavailable while GOAT Bot's computer is offline."))
    .toBeVisible();
  expect(screen.getByRole("button", { name: "Try again" }).query()).toBeNull();
});

const local = (hour: number, minute = 0) => new Date(2026, 10, 14, hour, minute).toISOString();
const conversation = (inputId: string, thread: ThreadId = threadId) => ({
  threadId: thread,
  inputId: ChannelInputId.make(inputId),
});
const run = (
  hour: number,
  status: string,
  extra: Partial<ScheduledTaskRecentRun> = {},
): ScheduledTaskRecentRun => ({
  firingId: CommandId.make(`firing-${hour}`),
  status,
  requestedAt: local(hour),
  completedAt: null,
  ...extra,
});
const finished = (hour: number, status: string, inputId?: string) =>
  run(hour, status, {
    completedAt: local(hour, 5),
    ...(inputId === undefined ? {} : { conversation: conversation(inputId) }),
  });
const routine = (
  title: string,
  recentRuns: ScheduledTaskRecentRun[] | undefined,
  extra: Partial<BotRoutineSource> = {},
): BotRoutineSource => ({
  ...savedCheckIn,
  id: ScheduledTaskId.make(`routine:${title}`),
  title,
  ...(recentRuns === undefined ? {} : { recentRuns }),
  ...extra,
});
const answer = (inputId: string, data: unknown, error: string | null = null) =>
  reads.answers.set(`input:env:${inputId}`, { data, error });
const readKeys = () => reads.keys.filter((key): key is string => key !== null);
function routines(
  tasks: BotRoutineSource[],
  props: Partial<Parameters<typeof GoatBotRoutines>[0]> = {},
  hidden = false,
) {
  // Always under the context, so hiding the chat rerenders the same tree instead of remounting it.
  return (
    <GoatBotChatHidden value={hidden}>
      <GoatBotRoutines
        environmentId={environmentId}
        threadId={threadId}
        tasks={tasks}
        error={null}
        onRetry={() => {}}
        {...props}
      />
    </GoatBotChatHidden>
  );
}
const dot = (name: string) => page.getByRole("button", { name, exact: true });
const popup = () => page.getByRole("dialog");
/** Opens a dot, returns what its popover says, and closes it again. */
async function readRun(name: string) {
  await userEvent.click(dot(name));
  await expect.element(popup()).toBeVisible();
  const said = popup().element().textContent ?? "";
  await userEvent.keyboard("{Escape}");
  await expect.element(popup()).not.toBeInTheDocument();
  // Escape gives focus back to the dot that opened the run.
  expect(document.activeElement).toBe(dot(name).element());
  return said;
}

it("a routine's recent runs are one toolbar stop whose dots name each run in the Timestamp format's hours", async () => {
  setup();
  const recentRuns = [9, 8, 7, 6, 5, 4, 3, 2].map((hour) =>
    finished(hour, "completed", `in-${hour}`),
  );
  const tasks = [
    routine("Morning check", recentRuns),
    routine("Unrecorded", undefined),
    routine("Fresh", []),
  ];
  await using screen = await render(routines(tasks));
  // Histories left out or empty draw nothing.
  expect(screen.getByRole("toolbar").elements()).toHaveLength(1);
  const strip = screen.getByRole("toolbar", { name: "Recent runs of Morning check" });
  const dots = () => strip.getByRole("button").elements();
  expect(dots().map((button) => button.getAttribute("aria-label"))).toEqual(
    [3, 4, 5, 6, 7, 8, 9].map((hour) => `Run on Nov 14, 0${hour}:00, completed`),
  );
  const tabStops = () => dots().filter((button) => button.tabIndex === 0);
  expect(tabStops()).toHaveLength(1);
  const focused = () => document.activeElement?.getAttribute("aria-label");
  dots()[0]?.focus();
  await userEvent.keyboard("{ArrowRight}");
  expect(focused()).toBe("Run on Nov 14, 04:00, completed");
  await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
  expect(focused()).toBe("Run on Nov 14, 09:00, completed");
  expect(tabStops()).toEqual([document.activeElement]);
  reads.timestampFormat = "12-hour";
  // Settings are not reactive here, so fresh tasks make the rows draw again.
  await screen.rerender(routines(tasks.map((task) => ({ ...task }))));
  await expect.element(dot("Run on Nov 14, 9:00 AM, completed")).toBeInTheDocument();
  expect(dot("Run on Nov 14, 09:00, completed").query()).toBeNull();
});

it("a dot opens its run in the shared words, and reads only an ended run that reached the bot", async () => {
  setup();
  answer("in-6", { reply: { text: "All quiet on the build." } });
  answer("in-5", { failure: { reason: "provider", message: "The model refused." } });
  answer("in-4", {});
  answer("in-3", null, "offline");
  const morning = routine(
    "Morning check",
    [
      run(9, "failed", { dispatchFailed: true }),
      run(8, "failed", { dispatchFailed: true }),
      run(7, "running", { conversation: conversation("in-7") }),
      finished(6, "completed", "in-6"),
      finished(5, "failed", "in-5"),
      finished(4, "completed", "in-4"),
      finished(3, "completed", "in-3"),
    ],
    {
      lastRun: { firingId: CommandId.make("firing-9") } as unknown as BotRoutineSource["lastRun"],
      lastRunError: "GOAT Bot is paused.\nmore detail",
    },
  );
  const evening = routine("Evening check", [
    run(15, "completed", { quiet: true, conversation: conversation("in-15") }),
    run(14, "paused_by_policy", { conversation: conversation("in-14") }),
    finished(13, "completed"),
    finished(12, "completed", "in-12"),
  ]);
  await using _screen = await render(routines([morning, evening]));
  const newest = await readRun("Run on Nov 14, 09:00, dispatch failed");
  expect(newest).toContain("GOAT Bot is paused.");
  expect(newest).not.toContain("more detail");
  expect(await readRun("Run on Nov 14, 08:00, dispatch failed")).toContain(
    "This run didn't reach GOAT Bot.",
  );
  expect(await readRun("Run on Nov 14, 07:00, running")).toContain("Still running.");
  expect(await readRun("Run on Nov 14, 06:00, completed")).toContain("All quiet on the build.");
  await userEvent.click(dot("Run on Nov 14, 05:00, failed"));
  await expect
    .element(page.getByRole("dialog", { name: "Failed · Nov 14, 05:00, finished 05:05" }))
    .toMatchTextContent("The model refused.");
  await userEvent.keyboard("{Escape}");
  await expect.element(popup()).not.toBeInTheDocument();
  expect(await readRun("Run on Nov 14, 04:00, completed")).toContain(
    "Details for this run aren't available.",
  );
  expect(await readRun("Run on Nov 14, 03:00, completed")).toContain("Couldn't load this run.");
  expect(await readRun("Run on Nov 14, 15:00, no update")).toContain("No update");
  expect(await readRun("Run on Nov 14, 14:00, outcome unavailable")).toContain(
    "Details for this run aren't available.",
  );
  // A run the bot took whose link is gone is neither a failure to reach it nor a reply.
  expect(await readRun("Run on Nov 14, 13:00, completed")).toContain(
    "Details for this run aren't available.",
  );
  expect(await readRun("Run on Nov 14, 12:00, completed")).toContain("Loading…");
  expect(new Set(readKeys())).toEqual(
    new Set(["in-6", "in-5", "in-4", "in-3", "in-12"].map((id) => `input:env:${id}`)),
  );
});

it("an open run that is still running reads once the list shows it ended", async () => {
  setup();
  const runs = (overrides: Record<number, ScheduledTaskRecentRun> = {}) =>
    [
      run(9, "running", { conversation: conversation("in-9") }),
      run(8, "paused_by_policy", { conversation: conversation("in-8") }),
      run(7, "running", { conversation: conversation("in-7") }),
    ].map((entry, index) => overrides[9 - index] ?? entry);
  await using screen = await render(routines([routine("Morning check", runs())]));
  await userEvent.click(dot("Run on Nov 14, 09:00, running"));
  await expect.element(popup()).toMatchTextContent("Still running.");
  expect(readKeys()).toEqual([]);
  answer("in-9", { reply: { text: "Build is green." } });
  await screen.rerender(
    routines([routine("Morning check", runs({ 9: finished(9, "completed", "in-9") }))]),
  );
  await expect.element(popup()).toMatchTextContent("Build is green.");
  expect(new Set(readKeys())).toEqual(new Set(["input:env:in-9"]));
  await userEvent.keyboard("{Escape}");
  await expect.element(popup()).not.toBeInTheDocument();

  // An unsettled run waits like a running one, with its own words.
  await userEvent.click(dot("Run on Nov 14, 08:00, outcome unavailable"));
  await expect.element(popup()).toMatchTextContent("Details for this run aren't available.");
  expect(readKeys()).not.toContain("input:env:in-8");
  answer("in-8", { reply: { text: "Paused, then done." } });
  const settled = run(8, "paused_by_policy", {
    completedAt: local(8, 5),
    conversation: conversation("in-8"),
  });
  await screen.rerender(routines([routine("Morning check", runs({ 8: settled }))]));
  await expect.element(popup()).toMatchTextContent("Paused, then done.");
  await userEvent.keyboard("{Escape}");
  await expect.element(popup()).not.toBeInTheDocument();

  // A quiet completion says No update and is never read.
  await userEvent.click(dot("Run on Nov 14, 07:00, running"));
  const quiet = run(7, "completed", {
    completedAt: local(7, 5),
    quiet: true,
    conversation: conversation("in-7"),
  });
  await screen.rerender(routines([routine("Morning check", runs({ 7: quiet }))]));
  await expect.element(popup()).toMatchTextContent("No update");
  expect(readKeys()).not.toContain("input:env:in-7");
});

it("a run pushed out of the seven closes its popover", async () => {
  setup();
  answer("in-1", { reply: { text: "Old reply." } });
  const old = finished(1, "completed", "in-1");
  await using screen = await render(routines([routine("Morning check", [old])]));
  await userEvent.click(dot("Run on Nov 14, 01:00, completed"));
  await expect.element(popup()).toMatchTextContent("Old reply.");
  const before = reads.keys.length;
  const newer = [8, 7, 6, 5, 4, 3, 2].map((hour) => finished(hour, "completed", `in-${hour}`));
  await screen.rerender(routines([routine("Morning check", [...newer, old])]));
  await expect.element(popup()).not.toBeInTheDocument();
  expect(dot("Run on Nov 14, 01:00, completed").query()).toBeNull();
  expect(reads.keys.slice(before).filter((key) => key !== null)).toEqual([]);
});

it("docked: a task hiding the chat closes the run popover and reads nothing", async () => {
  setup();
  const running = run(9, "running", { conversation: conversation("in-9") });
  await using screen = await render(
    routines([routine("Morning check", [running])], { docked: true }),
  );
  await userEvent.click(dot("Run on Nov 14, 09:00, running"));
  await expect.element(popup()).toMatchTextContent("Still running.");
  await screen.rerender(routines([routine("Morning check", [running])], { docked: true }, true));
  await expect.element(popup()).not.toBeInTheDocument();
  answer("in-9", { reply: { text: "Build is green." } });
  const ended = finished(9, "completed", "in-9");
  await screen.rerender(routines([routine("Morning check", [ended])], { docked: true }, true));
  await expect.element(dot("Run on Nov 14, 09:00, completed")).toBeInTheDocument();
  expect(popup().query()).toBeNull();
  expect(readKeys()).toEqual([]);
});

it("sheet: a dot still opens its run while the chat is hidden, without Show in chat", async () => {
  setup();
  answer("in-9", { reply: { text: "Build is green." } });
  await using _screen = await render(
    routines(
      [routine("Morning check", [finished(9, "completed", "in-9")])],
      { docked: false },
      true,
    ),
  );
  await userEvent.click(dot("Run on Nov 14, 09:00, completed"));
  await expect.element(popup()).toMatchTextContent("Build is green.");
  expect(readKeys()).toContain("input:env:in-9");
  expect(popup().getByRole("button", { name: "Show in chat" }).query()).toBeNull();
});

it("Show in chat is offered only for a run the chat can show, and closes the popover without taking focus back", async () => {
  setup();
  for (const id of ["in-9", "in-8", "in-7"]) answer(id, { reply: { text: `Reply ${id}` } });
  const elsewhere = run(8, "completed", {
    completedAt: local(8, 5),
    conversation: conversation("in-8", ThreadId.make("replaced-bot")),
  });
  const tasks = [
    routine("Morning check", [
      finished(9, "completed", "in-9"),
      elsewhere,
      finished(7, "completed", "in-7"),
    ]),
  ];
  const show = vi.fn(() => document.getElementById("reply-row")?.focus());
  const showRunInChat = vi.fn((inputId: string) => (inputId === "in-7" ? undefined : show));
  await using screen = await render(
    <>
      {routines(tasks, { docked: true, showRunInChat })}
      <button type="button" id="reply-row">
        Reply row
      </button>
    </>,
  );
  const offer = () => popup().getByRole("button", { name: "Show in chat" });
  // Another bot thread's run, and a run the chat has no row for.
  for (const name of ["Run on Nov 14, 08:00, completed", "Run on Nov 14, 07:00, completed"]) {
    await userEvent.click(dot(name));
    await expect.element(popup()).toBeVisible();
    expect(offer().query()).toBeNull();
    await userEvent.keyboard("{Escape}");
    await expect.element(popup()).not.toBeInTheDocument();
  }
  await userEvent.click(dot("Run on Nov 14, 09:00, completed"));
  await userEvent.click(offer());
  expect(show).toHaveBeenCalledOnce();
  await expect.element(popup()).not.toBeInTheDocument();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Reply row" }).element());
});

it("opening another dot keeps the new run open with focus inside", async () => {
  setup();
  for (const id of ["in-9", "in-8"]) answer(id, { reply: { text: `Reply ${id}` } });
  const tasks = [
    routine("Morning check", [finished(9, "completed", "in-9"), finished(8, "completed", "in-8")]),
  ];
  await using _screen = await render(routines(tasks));
  const nine = page.getByRole("dialog", { name: "Completed · Nov 14, 09:00, finished 09:05" });
  const eight = page.getByRole("dialog", { name: "Completed · Nov 14, 08:00, finished 08:05" });
  await userEvent.click(dot("Run on Nov 14, 09:00, completed"));
  await expect.element(nine).toBeVisible();
  // The run that closes as another opens must not pull focus back to its dot.
  await userEvent.click(dot("Run on Nov 14, 08:00, completed"));
  await expect.element(nine).not.toBeInTheDocument();
  await expect.element(eight).toMatchTextContent("Reply in-8");
  expect(eight.element().contains(document.activeElement)).toBe(true);
});

it("a run closed by focusing something else leaves focus there", async () => {
  setup();
  answer("in-9", { reply: { text: "Reply in-9" } });
  await using screen = await render(
    <>
      {/* Above the strip, so the popover below its dot does not cover it. */}
      <button type="button">Elsewhere</button>
      {routines([routine("Morning check", [finished(9, "completed", "in-9")])])}
    </>,
  );
  await userEvent.click(dot("Run on Nov 14, 09:00, completed"));
  await expect.element(popup()).toMatchTextContent("Reply in-9");
  const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
  await userEvent.click(elsewhere);
  await expect.element(popup()).not.toBeInTheDocument();
  expect(document.activeElement).toBe(elsewhere.element());
});
