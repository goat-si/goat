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
  notes: [] as Array<{ index: number; date: string | null; text: string }>,
  refresh: vi.fn(),
}));
vi.mock("../WorkspacePageHeader", () => ({
  WorkspacePageHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
}));
vi.mock("./GoatBotModelPicker", () => ({ GoatBotModelPicker: () => null }));
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
    rows: [],
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
  state.notes = [note];
  state.refresh.mockReset();
  const onSend = vi.fn<(text: string) => void>();
  const view = (rows: GoatBotRow[] = []) => (
    <GoatBotChatView
      availability={{ kind: "ready", bot: { environmentId, threadId: ThreadId.make("bot") } }}
      canOperate
      rows={rows}
      onSend={onSend}
      onRetryInput={() => {}}
      legacyAgentRoute={null}
      attachmentSupport={{ maxUploadBytes: 1_000_000 }}
    />
  );
  return { view, onSend };
}

async function openMemory(screen: Awaited<ReturnType<typeof render>>) {
  await userEvent.click(screen.getByRole("button", { name: "Toggle GOAT Bot work panel" }));
  // The narrow layout puts the panel in a sheet outside the rendered container.
  await userEvent.click(page.getByRole("tab", { name: "Memory" }));
}

const composer = (screen: Awaited<ReturnType<typeof render>>) =>
  screen.getByRole("textbox", { name: "Message GOAT Bot" });

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
  await expect.element(page.getByRole("tab", { name: "Memory" })).not.toBeInTheDocument();
  await expect.element(composer(screen)).toHaveValue(goatBotForgetNoteMessage(note.text));
  expect(onSend).not.toHaveBeenCalled();
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

it("the open Memory tab reads the notes again after the answer and after the task finishes", async () => {
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
  await expect
    .element(screen.getByText("No notes yet. Ask GOAT Bot to remember a standing rule."))
    .toBeVisible();
  await userEvent.click(screen.getByRole("tab", { name: "Tasks" }));
  await userEvent.click(screen.getByRole("tab", { name: "Memory" }));
  expect(state.refresh).toHaveBeenCalledTimes(opened + 4);
});
