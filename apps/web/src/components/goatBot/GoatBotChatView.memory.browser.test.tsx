import type { GoatBotRow, GoatBotTaskCard } from "@goat/client-runtime/goatBot";
import {
  EnvironmentId,
  goatBotChangeNoteMessage,
  goatBotForgetNoteMessage,
  ThreadId,
} from "@goat/contracts";
import { type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

import "~/index.css";

const state = vi.hoisted(() => ({
  narrow: false,
  threads: [] as ReadonlyArray<unknown>,
  notes: [] as Array<{ index: number; date: string | null; text: string }>,
  refresh: vi.fn(),
}));
vi.mock("../WorkspacePageHeader", () => ({
  WorkspacePageHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
}));
vi.mock("./GoatBotModelPicker", () => ({
  GoatBotModelPicker: () => <button type="button">Choose model</button>,
}));
vi.mock("./GoatBotAvatar", () => ({
  GoatBotAvatar: () => null,
  GoatBotMainAvatar: () => null,
  GoatBotSessionAvatar: () => null,
}));
vi.mock("./GoatBotTimeline", async (original) => ({
  ...(await original<typeof import("./GoatBotTimeline")>()),
  GoatBotTimeline: () => null,
}));
vi.mock("~/hooks/useMediaQuery", () => ({ useMediaQuery: () => state.narrow }));
vi.mock("./GoatBotStatusCard", () => ({ GoatBotStatusCard: () => null }));
vi.mock("./useBotRoster", () => ({
  useBotThreads: () => ({
    rows: state.threads,
    remoteWork: [],
    supported: true,
    loaded: true,
    failed: false,
    turnsWaiting: [],
    refresh: () => {},
  }),
}));
vi.mock("~/state/server", async (original) => {
  const real = await original<typeof import("~/state/server")>();
  return {
    ...real,
    serverEnvironment: { ...real.serverEnvironment, scheduledTasksLive: () => "routines" },
  };
});
vi.mock("~/state/channels", async (original) => {
  const real = await original<typeof import("~/state/channels")>();
  return {
    ...real,
    channelEnvironment: { ...real.channelEnvironment, listBotNotes: () => "notes" },
  };
});
vi.mock("~/state/entities", async (original) => ({
  ...(await original<typeof import("~/state/entities")>()),
  useServerConfigs: () =>
    new Map([["local", { environment: { capabilities: { goatBotNotes: true } } }]]),
}));
vi.mock("~/state/query", async (original) => ({
  ...(await original<typeof import("~/state/query")>()),
  useEnvironmentQuery: (atom: unknown) =>
    atom === "notes"
      ? {
          data: { revision: "r", notes: state.notes, truncated: false },
          failure: null,
          error: null,
          isPending: false,
          isSuccess: true,
          refresh: state.refresh,
        }
      : {
          data: { tasks: [] },
          failure: null,
          error: null,
          isPending: false,
          isSuccess: true,
          refresh: () => {},
        },
}));

import { GoatBotChatView } from "./GoatBotChatView";

const note = { index: 0, date: "2026-11-07", text: 'Reply in "Korean"' };
const environmentId = EnvironmentId.make("local");

function setup(narrow = false) {
  state.narrow = narrow;
  state.threads = [];
  state.notes = [note];
  state.refresh.mockReset();
  const onSend = vi.fn<(text: string) => void>();
  const view = (rows: GoatBotRow[] = [], peek = false) => (
    <GoatBotChatView
      availability={{ kind: "ready", bot: { environmentId, threadId: ThreadId.make("bot") } }}
      canOperate
      rows={rows}
      onSend={onSend}
      onRetryInput={() => {}}
      legacyAgentRoute={null}
      attachmentSupport={{ maxUploadBytes: 1_000_000 }}
      rowsForTask={peek ? () => [] : undefined}
    />
  );
  return { view, onSend };
}

async function openMemory(screen: Awaited<ReturnType<typeof render>>) {
  await userEvent.click(screen.getByRole("button", { name: "GOAT Bot home" }));
  // The narrow layout puts the panel in a sheet outside the rendered container.
  await userEvent.click(page.getByRole("tab", { name: "Library" }));
}

const composer = (screen: Awaited<ReturnType<typeof render>>) =>
  screen.getByRole("textbox", { name: "Message GOAT Bot" });

it("the home chip toggles by click and keyboard without losing the draft", async () => {
  const { view } = setup();
  await using screen = await render(view());
  const chip = screen.getByRole("button", { name: "GOAT Bot home" });
  const field = composer(screen);
  await userEvent.type(field, "Keep this draft");
  await expect.element(chip).toHaveAttribute("aria-expanded", "false");
  await userEvent.click(chip);
  await expect.element(chip).toHaveAttribute("aria-expanded", "true");
  await expect.element(screen.getByRole("tab", { name: "Home" })).toBeVisible();
  await userEvent.keyboard("{Enter}");
  await expect.element(chip).toHaveAttribute("aria-expanded", "false");
  await expect.element(field).toHaveValue("Keep this draft");
  expect(
    screen.getByRole("button", { name: "Choose model" }).element().closest("form"),
  ).not.toBeNull();
});

it("closing the narrow home sheet returns focus and keeps the draft", async () => {
  const { view } = setup(true);
  await using screen = await render(view());
  const chip = screen.getByRole("button", { name: "GOAT Bot home" });
  const field = composer(screen);
  await userEvent.type(field, "Draft on mobile");
  await userEvent.click(chip);
  await userEvent.click(page.getByRole("button", { name: "Close" }));
  await expect.element(chip).toHaveFocus();
  await expect.element(chip).toHaveAttribute("aria-expanded", "false");
  await expect.element(field).toHaveValue("Draft on mobile");
});

it("in the narrow sheet Escape steps from a task back to Home, then closes the sheet, keeping the draft", async () => {
  const { view } = setup(true);
  const at = "2026-11-09T00:00:00.000Z";
  state.threads = [
    {
      kind: "task",
      task: {
        taskId: "task-a",
        title: "Stop the port 3774 server",
        status: "running",
        updatedAt: at,
      },
      view: { taskId: "task-a", pinnedAt: null, doneAt: null, readThrough: null },
      lastActivityAt: at,
      unread: false,
      mainMessagesSinceQuiet: 0,
      worker: { environmentId: "local", threadId: "channel-worker:a" },
    },
  ];
  await using screen = await render(view([], true));
  const chip = screen.getByRole("button", { name: "GOAT Bot home" });
  const field = composer(screen);
  await userEvent.type(field, "Half a thought");
  await userEvent.click(chip);
  await expect.element(page.getByRole("tab", { name: "Home" })).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: /Stop the port 3774 server/ }));
  await expect.element(page.getByText("Go to thread")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  // The first Escape leaves the task; the sheet stays open on Home.
  await expect.element(page.getByText("Go to thread")).not.toBeInTheDocument();
  await expect.element(page.getByRole("tab", { name: "Home" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("tab", { name: "Home" })).not.toBeInTheDocument();
  await expect.element(chip).toHaveFocus();
  await expect.element(field).toHaveValue("Half a thought");
});

it("New routine starts a routine request in the composer and sends nothing", async () => {
  const { view, onSend } = setup();
  await using screen = await render(view());
  await userEvent.click(screen.getByRole("button", { name: "GOAT Bot home" }));
  await userEvent.click(screen.getByRole("button", { name: "New routine" }));
  await expect.element(composer(screen)).toHaveValue("Set up a routine: ");
  await expect.element(composer(screen)).toHaveFocus();
  expect(onSend).not.toHaveBeenCalled();
});

it("Ask to forget puts the quoted note in the composer and sends nothing", async () => {
  const { view, onSend } = setup();
  await using screen = await render(view());
  await openMemory(screen);
  await userEvent.click(screen.getByRole("button", { name: "Ask to forget" }));
  await expect.element(composer(screen)).toHaveValue(goatBotForgetNoteMessage(note.text));
  expect(onSend).not.toHaveBeenCalled();
});

it("Ask to change puts the quoted change in the composer and keeps a staged file", async () => {
  const { view, onSend } = setup();
  await using screen = await render(view());
  const file = new File(["hello"], "notes.txt", { type: "text/plain" });
  const input = screen.container.querySelector<HTMLInputElement>("input[type=file]")!;
  const transfer = new DataTransfer();
  transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await expect.element(screen.getByText("notes.txt")).toBeVisible();
  await openMemory(screen);
  await userEvent.click(screen.getByRole("button", { name: "Ask to change" }));
  const field = screen.getByRole("textbox", { name: "New wording" });
  await userEvent.clear(field);
  await userEvent.type(field, "Reply in English");
  await userEvent.click(screen.getByRole("button", { name: "Fill message" }));
  await expect
    .element(composer(screen))
    .toHaveValue(goatBotChangeNoteMessage(note.text, "Reply in English"));
  await expect.element(screen.getByText("notes.txt")).toBeVisible();
  expect(onSend).not.toHaveBeenCalled();
});

it("on a narrow screen the work sheet closes and the composer holds the draft", async () => {
  const { view, onSend } = setup(true);
  await using screen = await render(view());
  await openMemory(screen);
  await userEvent.click(page.getByRole("button", { name: "Ask to forget" }));
  await expect.element(page.getByRole("tab", { name: "Library" })).not.toBeInTheDocument();
  const field = composer(screen);
  const drafted = goatBotForgetNoteMessage(note.text);
  await expect.element(field).toHaveValue(drafted);
  // The person edits and sends from the keyboard, so the caret waits at the end of the draft.
  await expect.element(field).toHaveFocus();
  expect((field.element() as HTMLTextAreaElement).selectionStart).toBe(drafted.length);
  expect(onSend).not.toHaveBeenCalled();
  // Opening and dismissing the sheet afterwards still returns focus to the chip.
  const chip = screen.getByRole("button", { name: "GOAT Bot home" });
  await userEvent.click(chip);
  await userEvent.click(page.getByRole("button", { name: "Close" }));
  await expect.element(chip).toHaveFocus();
});

const botRow = (text: string): GoatBotRow => ({
  kind: "bot",
  id: "reply-1",
  text,
  createdAt: "2026-11-07T10:00:00.000Z",
  tone: "reply",
  proactive: false,
  replyTo: null,
  options: [],
  firstInGroup: true,
  groupPosition: "single",
});
const taskRow = (revision: number, statusLabel: string): GoatBotRow => {
  const card: GoatBotTaskCard = {
    key: "task-1",
    revision,
    updatedAt: "2026-11-07T10:01:00.000Z",
    title: "Forget a note",
    statusLabel,
    tone: revision > 1 ? "success" : "active",
    sourceLabel: null,
    summary: null,
    attentionLabel: null,
    pullRequests: [],
    target: { kind: "thread", environmentId, threadId: ThreadId.make("task-thread") },
  };
  return {
    kind: "task",
    id: "card-1",
    createdAt: "2026-11-07T10:01:00.000Z",
    card,
    firstInGroup: true,
    groupPosition: "single",
  };
};

it("the memory in Library reads the notes again after the answer and after the task finishes", async () => {
  const { view } = setup();
  await using screen = await render(view());
  await openMemory(screen);
  await expect.element(screen.getByText(note.text)).toBeVisible();
  const opened = state.refresh.mock.calls.length;
  expect(opened).toBeGreaterThan(0);
  await screen.rerender(view([botRow("On it.")]));
  expect(state.refresh).toHaveBeenCalledTimes(opened + 1);
  await screen.rerender(view([botRow("On it."), taskRow(1, "Working")]));
  expect(state.refresh).toHaveBeenCalledTimes(opened + 2);
  state.notes = [];
  await screen.rerender(view([botRow("On it."), taskRow(2, "Done")]));
  expect(state.refresh).toHaveBeenCalledTimes(opened + 3);
  await expect.element(screen.getByText("No notes yet")).toBeVisible();
  await userEvent.click(screen.getByRole("tab", { name: "Home" }));
  await userEvent.click(screen.getByRole("tab", { name: "Library" }));
  expect(state.refresh).toHaveBeenCalledTimes(opened + 4);
});
