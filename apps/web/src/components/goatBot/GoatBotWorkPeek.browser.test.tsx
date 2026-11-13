import { ChannelTaskId, EnvironmentId, ThreadId } from "@goat/contracts";
import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import { StrictMode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const actions = vi.hoisted(() => ({ update: vi.fn(), refresh: vi.fn(), permit: true }));
vi.mock("~/state/channels", async (original) => {
  const { Atom } = await import("effect/reactivity");
  const real = await original<typeof import("~/state/channels")>();
  return {
    ...real,
    channelEnvironment: {
      ...real.channelEnvironment,
      updateTaskView: {
        permissionAtom: () => Atom.make(actions.permit),
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

import { render } from "../../../test/render";
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

it("acknowledges a task's unread activity the way its task view does", async () => {
  actions.permit = true;
  actions.update.mockReset();
  actions.update.mockResolvedValue({ _tag: "Success" });
  actions.refresh.mockReset();
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
  actions.permit = true;
  actions.update.mockReset();
  actions.update.mockResolvedValue({ _tag: "Success" });
  actions.refresh.mockReset();
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
  actions.update.mockReset();
  actions.refresh.mockReset();
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
  actions.permit = true;
});
