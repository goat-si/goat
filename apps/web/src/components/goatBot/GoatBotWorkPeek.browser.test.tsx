import { ChannelTaskId, EnvironmentId, ThreadId } from "@goat/contracts";
import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

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
