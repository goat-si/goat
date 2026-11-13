import { ChannelTaskId, EnvironmentId, ThreadId } from "@goat/contracts";
import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import { StrictMode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const actions = vi.hoisted(() => ({
  update: vi.fn(),
  refresh: vi.fn(),
  permit: true,
  // Read through useAtomValue on every render, so a test can take permission away and back.
  permission: { permission: "updateTaskView" },
}));
vi.mock("@effect/atom-react", async (original) => {
  const real = await original<typeof import("@effect/atom-react")>();
  return {
    ...real,
    useAtomValue: ((atom: unknown, ...rest: unknown[]) =>
      atom === actions.permission
        ? actions.permit
        : (real.useAtomValue as (...args: unknown[]) => unknown)(
            atom,
            ...rest,
          )) as typeof real.useAtomValue,
  };
});
vi.mock("~/state/channels", async (original) => {
  const real = await original<typeof import("~/state/channels")>();
  return {
    ...real,
    channelEnvironment: {
      ...real.channelEnvironment,
      updateTaskView: {
        permissionAtom: () => actions.permission,
        execute: actions.update,
      },
    },
  };
});
vi.mock("~/state/use-atom-command", async (original) => {
  const real = await original<typeof import("~/state/use-atom-command")>();
  return {
    ...real,
    // A new function on every render, as the real hook returns.
    useAtomCommand: (command: { execute: typeof actions.update }) => (value: unknown) =>
      command.execute(value),
  };
});

import { act, render } from "../../../test/render";
import "../../index.css";

// Atoms derived from the server config run in the real registry over a missing config.
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const noConfig = Atom.make(null);
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => noConfig) as never },
  };
});
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: (() => true) as never,
  readEnvironmentScope: (() => true) as never,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useThreadShell: (() => null) as never,
  useEnvironmentShellsBootstrapped: (() => true) as never,
}));
vi.mock(import("../../remoteOpen"), async (original) => ({
  ...(await original()),
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }) as never,
}));
vi.mock("../settings/MemorySettings", () => ({ MemorySettingsEntry: () => null }));

import { GoatBotWorkPeek } from "./GoatBotWorkPeek";
import { resetTaskReadAcknowledgementsForTests } from "./useAcknowledgeTaskRead";

const at = "2026-11-09T00:00:00.000Z";
const rows: ReadonlyArray<GoatBotRow> = [
  {
    kind: "task",
    id: "card",
    createdAt: at,
    card: {
      key: "task-a",
      revision: 2,
      updatedAt: at,
      title: "Count the stars",
      statusLabel: "Done",
      tone: "success",
      sourceLabel: null,
      summary: "Counted in [the report](goat-thread://v1/report-thread).",
      attentionLabel: null,
      pullRequests: [],
      target: {
        kind: "thread",
        environmentId: EnvironmentId.make("worker-home"),
        threadId: ThreadId.make("worker-thread"),
      },
    },
    firstInGroup: true,
    groupPosition: "single",
  },
  {
    kind: "bot",
    id: "reply",
    text: "The repository has 17.8k stars.",
    createdAt: at,
    tone: "reply",
    proactive: false,
    replyTo: null,
    options: [],
    firstInGroup: true,
    groupPosition: "single",
  },
];

it("reads a task's real conversation with one way to its thread, and Escape goes back", async () => {
  const onBack = vi.fn();
  await using screen = await render(
    <GoatBotWorkPeek
      taskId={ChannelTaskId.make("task-a")}
      title="Count the stars"
      statusLabel="Done"
      rows={rows}
      environmentId={EnvironmentId.make("bot-home")}
      onBack={onBack}
    />,
  );
  await expect.element(screen.getByText("The repository has 17.8k stars.")).toBeVisible();
  await expect
    .element(screen.getByRole("link", { name: "Thread, the report" }))
    .toHaveAttribute("href", "/worker-home/report-thread");
  await expect
    .element(screen.getByRole("link", { name: "Go to thread" }))
    .toHaveAttribute("href", expect.stringContaining("task=task-a"));
  expect(screen.getByRole("link", { name: "Open thread" }).all()).toHaveLength(0);
  await userEvent.keyboard("{Escape}");
  expect(onBack).toHaveBeenCalledOnce();
});

/** A peek at one task, unread through the given activity, as the panel renders it. */
function ackPeek(
  taskId: string,
  unreadThrough: string | null,
  statusLabel = "Done",
  environmentId = "bot-home",
) {
  return (
    <GoatBotWorkPeek
      taskId={ChannelTaskId.make(taskId)}
      title="Count the stars"
      statusLabel={statusLabel}
      rows={rows}
      environmentId={EnvironmentId.make(environmentId)}
      unreadThrough={unreadThrough}
      onAcknowledged={actions.refresh}
      onBack={() => {}}
    />
  );
}

/** Resets the shared acknowledgement record and the mocks every acknowledgement test reads. */
function setup() {
  resetTaskReadAcknowledgementsForTests();
  actions.permit = true;
  actions.update.mockReset();
  actions.update.mockResolvedValue({ _tag: "Success" });
  actions.refresh.mockReset();
}

const sentFor = (taskId: string, environmentId = "bot-home") =>
  actions.update.mock.calls.filter(
    ([value]) => value.input.taskId === taskId && value.environmentId === environmentId,
  ).length;

/** An update that answers only when the test lets it. */
function holdNextUpdate() {
  let land = (_result: { _tag: string }) => {};
  actions.update.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        land = resolve;
      }),
  );
  return (result: { _tag: string }) => land(result);
}

it("acknowledges a task's unread activity the way its task view does", async () => {
  setup();
  await using _screen = await render(
    <GoatBotWorkPeek
      taskId={ChannelTaskId.make("task-a")}
      title="Count the stars"
      statusLabel="Done"
      rows={rows}
      environmentId={EnvironmentId.make("bot-home")}
      unreadThrough="2026-11-09T00:00:00.000Z"
      onAcknowledged={actions.refresh}
      onBack={() => {}}
    />,
  );
  await vi.waitFor(() =>
    expect(actions.update).toHaveBeenCalledWith({
      environmentId: "bot-home",
      input: { taskId: "task-a", readThrough: "2026-11-09T00:00:00.000Z" },
    }),
  );
  expect(actions.refresh).toHaveBeenCalledOnce();
});

it("acknowledges an unread task once through rerenders and Strict Mode", async () => {
  setup();
  const peek = (statusLabel: string) => (
    <StrictMode>
      <GoatBotWorkPeek
        taskId={ChannelTaskId.make("task-c")}
        title="Count the stars"
        statusLabel={statusLabel}
        rows={rows}
        environmentId={EnvironmentId.make("bot-home")}
        unreadThrough="2026-11-09T00:00:00.000Z"
        onAcknowledged={actions.refresh}
        onBack={() => {}}
      />
    </StrictMode>
  );
  await using screen = await render(peek("Status one"));
  await vi.waitFor(() => expect(actions.refresh).toHaveBeenCalled());
  // The row is still unread until the list is read again; new renders must not send it again.
  await screen.rerender(peek("Status two"));
  await screen.rerender(peek("Status three"));
  await expect.element(screen.getByText("Status three")).toBeVisible();
  expect(actions.update).toHaveBeenCalledOnce();
});

it("leaves the server alone when this device may not change the task view", async () => {
  setup();
  actions.permit = false;
  await using _screen = await render(
    <GoatBotWorkPeek
      taskId={ChannelTaskId.make("task-b")}
      title="Count the stars"
      statusLabel="Done"
      rows={rows}
      environmentId={EnvironmentId.make("bot-home")}
      unreadThrough="2026-11-09T00:00:00.000Z"
      onAcknowledged={actions.refresh}
      onBack={() => {}}
    />,
  );
  expect(actions.update).not.toHaveBeenCalled();
  expect(actions.refresh).not.toHaveBeenCalled();
});

it("does not retry a failed acknowledgement on rerender, and reopening the task sends it once", async () => {
  setup();
  actions.update.mockResolvedValueOnce({ _tag: "Failure" });
  const first = await render(ackPeek("task-fail", at));
  await vi.waitFor(() => expect(sentFor("task-fail")).toBe(1));
  await first.rerender(ackPeek("task-fail", at, "Status two"));
  await first.rerender(ackPeek("task-fail", at, "Status three"));
  await expect.element(first.getByText("Status three")).toBeVisible();
  expect(sentFor("task-fail")).toBe(1);
  await first[Symbol.asyncDispose]();
  await using _reopened = await render(ackPeek("task-fail", at));
  await vi.waitFor(() => expect(sentFor("task-fail")).toBe(2));
});

it("sends a failed acknowledgement once more when update permission comes back", async () => {
  setup();
  actions.update.mockResolvedValueOnce({ _tag: "Failure" });
  await using screen = await render(ackPeek("task-permit", at));
  await vi.waitFor(() => expect(sentFor("task-permit")).toBe(1));
  actions.permit = false;
  await screen.rerender(ackPeek("task-permit", at, "Denied"));
  await expect.element(screen.getByText("Denied")).toBeVisible();
  actions.permit = true;
  await screen.rerender(ackPeek("task-permit", at, "Allowed"));
  await vi.waitFor(() => expect(sentFor("task-permit")).toBe(2));
  await screen.rerender(ackPeek("task-permit", at, "Allowed again"));
  await expect.element(screen.getByText("Allowed again")).toBeVisible();
  expect(sentFor("task-permit")).toBe(2);
});

it("sends A once when the peek goes from A to B and back while A is still in flight", async () => {
  setup();
  let land = (_result: { _tag: string }) => {};
  actions.update.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        land = resolve;
      }),
  );
  await using screen = await render(ackPeek("task-a", at, "A"));
  await vi.waitFor(() => expect(sentFor("task-a")).toBe(1));
  await screen.rerender(ackPeek("task-b", at, "B"));
  await vi.waitFor(() => expect(sentFor("task-b")).toBe(1));
  await screen.rerender(ackPeek("task-a", at, "A again"));
  await expect.element(screen.getByText("A again")).toBeVisible();
  expect(sentFor("task-a")).toBe(1);
  land({ _tag: "Success" });
});

it("sends nothing more when a task is closed and reopened while its acknowledgement is in flight or after it landed", async () => {
  setup();
  let land = (_result: { _tag: string }) => {};
  actions.update.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        land = resolve;
      }),
  );
  const first = await render(ackPeek("task-reopen", at));
  await vi.waitFor(() => expect(sentFor("task-reopen")).toBe(1));
  await first[Symbol.asyncDispose]();
  const pending = await render(ackPeek("task-reopen", at, "Reopened while pending"));
  await expect.element(pending.getByText("Reopened while pending")).toBeVisible();
  expect(sentFor("task-reopen")).toBe(1);
  land({ _tag: "Success" });
  await vi.waitFor(() => expect(actions.refresh).toHaveBeenCalled());
  await pending[Symbol.asyncDispose]();
  await using _landed = await render(ackPeek("task-reopen", at, "Reopened after"));
  await expect.element(_landed.getByText("Reopened after")).toBeVisible();
  expect(sentFor("task-reopen")).toBe(1);
});

it("sends a new acknowledgement when newer activity arrives on an open task", async () => {
  setup();
  await using screen = await render(ackPeek("task-newer", at));
  await vi.waitFor(() => expect(sentFor("task-newer")).toBe(1));
  await screen.rerender(ackPeek("task-newer", "2026-11-09T01:00:00.000Z"));
  await vi.waitFor(() => expect(sentFor("task-newer")).toBe(2));
  expect(actions.update).toHaveBeenLastCalledWith({
    environmentId: "bot-home",
    input: { taskId: "task-newer", readThrough: "2026-11-09T01:00:00.000Z" },
  });
});

it("keeps environments apart when their ids would join into the same text", async () => {
  setup();
  const first = await render(ackPeek("c", at, "Done", "a|b"));
  await vi.waitFor(() => expect(actions.refresh).toHaveBeenCalledOnce());
  await first[Symbol.asyncDispose]();
  await using _second = await render(ackPeek("b|c", at, "Done", "a"));
  await vi.waitFor(() => expect(sentFor("b|c", "a")).toBe(1));
});

it("acknowledges an activity that is not a date again when the task is next opened", async () => {
  setup();
  const first = await render(ackPeek("task-undated", "not a date"));
  await vi.waitFor(() => expect(actions.refresh).toHaveBeenCalledOnce());
  await first[Symbol.asyncDispose]();
  await using _again = await render(ackPeek("task-undated", "not a date", "Again"));
  await vi.waitFor(() => expect(sentFor("task-undated")).toBe(2));
});

it("sends nothing more on rerender or when a pending request settles as a failure", async () => {
  setup();
  const land = holdNextUpdate();
  await using screen = await render(ackPeek("task-settle", at));
  await vi.waitFor(() => expect(sentFor("task-settle")).toBe(1));
  await screen.rerender(ackPeek("task-settle", at, "Status two"));
  await act(() => land({ _tag: "Failure" }));
  await screen.rerender(ackPeek("task-settle", at, "Status three"));
  await expect.element(screen.getByText("Status three")).toBeVisible();
  expect(sentFor("task-settle")).toBe(1);
});

it("does not retry a failed request because the task was reopened while it was out", async () => {
  setup();
  const land = holdNextUpdate();
  const first = await render(ackPeek("task-reopen-flight", at));
  await vi.waitFor(() => expect(sentFor("task-reopen-flight")).toBe(1));
  await first[Symbol.asyncDispose]();
  const reopened = await render(ackPeek("task-reopen-flight", at, "Reopened"));
  await act(() => land({ _tag: "Failure" }));
  await expect.element(reopened.getByText("Reopened")).toBeVisible();
  expect(sentFor("task-reopen-flight")).toBe(1);
  // Opening it again after the failure does send.
  await reopened[Symbol.asyncDispose]();
  await using _again = await render(ackPeek("task-reopen-flight", at, "Again"));
  await vi.waitFor(() => expect(sentFor("task-reopen-flight")).toBe(2));
});

it("sends once under Strict Mode even when that request fails", async () => {
  setup();
  const land = holdNextUpdate();
  await using screen = await render(<StrictMode>{ackPeek("task-strict-fail", at)}</StrictMode>);
  await vi.waitFor(() => expect(sentFor("task-strict-fail")).toBe(1));
  await act(() => land({ _tag: "Failure" }));
  await screen.rerender(<StrictMode>{ackPeek("task-strict-fail", at, "After")}</StrictMode>);
  await expect.element(screen.getByText("After")).toBeVisible();
  expect(sentFor("task-strict-fail")).toBe(1);
});
