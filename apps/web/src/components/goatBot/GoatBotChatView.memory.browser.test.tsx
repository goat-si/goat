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
  toasts: [] as string[],
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
vi.mock("../ui/toast", async (original) => ({
  ...(await original<typeof import("../ui/toast")>()),
  toastManager: { add: (toast: { title: string }) => state.toasts.push(toast.title) },
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
    channelEnvironment: {
      ...real.channelEnvironment,
      listBotNotes: () => "notes",
      slackSettings: () => "slack",
    },
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
    atom === null
      ? {
          data: null,
          failure: null,
          error: null,
          isPending: false,
          isSuccess: false,
          refresh: () => {},
        }
      : atom === "notes"
        ? {
            data: { revision: "r", notes: state.notes, truncated: false },
            failure: null,
            error: null,
            isPending: false,
            isSuccess: true,
            refresh: state.refresh,
          }
        : atom === "slack" || atom === "settings"
          ? {
              data: [],
              failure: null,
              error: null,
              isPending: false,
              isSuccess: true,
              refresh: () => {},
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
  state.toasts = [];
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

async function windowSize(width: number, height: number) {
  const before = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(width, height);
  return { [Symbol.asyncDispose]: () => page.viewport(before.width, before.height) };
}

const homeSheet = () => page.getByRole("dialog", { name: "GOAT Bot work" });

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

it.each([390, 820])(
  "at %i px Back to chat closes the home sheet, returns focus to the chip and keeps the draft",
  async (width) => {
    const { view } = setup(true);
    await using _window = await windowSize(width, 844);
    await using screen = await render(view());
    const chip = screen.getByRole("button", { name: "GOAT Bot home" });
    const field = composer(screen);
    await userEvent.type(field, "Draft on mobile");
    await userEvent.click(chip);
    await expect.element(homeSheet()).toBeVisible();
    const back = page.getByRole("button", { name: "Back to chat", exact: true });
    // First in the sheet, so a click or key that opens it lands here.
    await expect.element(back).toHaveFocus();
    await expect.element(page.getByRole("button", { name: "Close" })).not.toBeInTheDocument();
    await userEvent.click(back);
    await expect.element(homeSheet()).not.toBeInTheDocument();
    await expect.element(chip).toHaveFocus();
    await expect.element(chip).toHaveAttribute("aria-expanded", "false");
    await expect.element(field).toHaveValue("Draft on mobile");
  },
);

it("at 390 px the home sheet fills the window", async () => {
  const { view } = setup(true);
  await using _window = await windowSize(390, 844);
  await using screen = await render(view());
  await userEvent.click(screen.getByRole("button", { name: "GOAT Bot home" }));
  await expect.element(homeSheet()).toBeVisible();
  const box = homeSheet().element().getBoundingClientRect();
  expect({ width: box.width, height: box.height }).toEqual({ width: 390, height: 844 });
});

it("at 820 px the home stays a side sheet beside the chat (guard)", async () => {
  const { view } = setup(true);
  await using _window = await windowSize(820, 900);
  await using screen = await render(view());
  await userEvent.click(screen.getByRole("button", { name: "GOAT Bot home" }));
  await expect.element(homeSheet()).toBeVisible();
  // max-w-md: 28rem.
  expect(homeSheet().element().getBoundingClientRect().width).toBe(448);
});

it("a tap on the dimmed chat beside the narrow home closes it, returning focus to the chip and keeping the draft", async () => {
  const { view } = setup(true);
  await using _window = await windowSize(820, 900);
  await using screen = await render(view());
  const chip = screen.getByRole("button", { name: "GOAT Bot home" });
  const field = composer(screen);
  await userEvent.type(field, "Draft beside the sheet");
  await userEvent.click(chip);
  await expect.element(homeSheet()).toBeVisible();
  // The sheet's viewport covers the dimmed backdrop; a press on it outside the popup dismisses.
  const backdrop = document.querySelector<HTMLElement>("[data-slot=sheet-viewport]")!;
  await userEvent.click(page.elementLocator(backdrop), { position: { x: 40, y: 450 } });
  await expect.element(homeSheet()).not.toBeInTheDocument();
  await expect.element(chip).toHaveFocus();
  await expect.element(field).toHaveValue("Draft beside the sheet");
});

it("at 390 px the composer puts the message above attach, model and Send (guard)", async () => {
  const { view } = setup(true);
  await using _window = await windowSize(390, 844);
  await using screen = await render(view());
  const field = composer(screen);
  await userEvent.type(field, "Two rows");
  const bottom = field.element().getBoundingClientRect().bottom;
  for (const name of ["Attach files", "Choose model", "Send"]) {
    const control = screen.getByRole("button", { name, exact: true });
    await expect.element(control).toBeVisible();
    expect(control.element().getBoundingClientRect().top).toBeGreaterThanOrEqual(bottom);
  }
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
  await userEvent.click(page.getByRole("button", { name: /^Stop the port 3774 server/ }));
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

const stageFile = async (screen: Awaited<ReturnType<typeof render>>) => {
  const input = screen.container.querySelector<HTMLInputElement>("input[type=file]")!;
  const transfer = new DataTransfer();
  transfer.items.add(new File(["hello"], "notes.txt", { type: "text/plain" }));
  input.files = transfer.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await expect.element(screen.getByText("notes.txt")).toBeVisible();
};

it("Ask to change fills the composer with the quoted change", async () => {
  const { view, onSend } = setup();
  await using screen = await render(view());
  await openMemory(screen);
  await userEvent.click(screen.getByRole("button", { name: "Ask to change" }));
  const field = screen.getByRole("textbox", { name: "New wording" });
  await userEvent.clear(field);
  await userEvent.type(field, "Reply in English");
  await userEvent.click(screen.getByRole("button", { name: "Fill message" }));
  await expect
    .element(composer(screen))
    .toHaveValue(goatBotChangeNoteMessage(note.text, "Reply in English"));
  expect(onSend).not.toHaveBeenCalled();
});

it("a draft action never replaces the person's typed message or rides on their staged files", async () => {
  const { view, onSend } = setup();
  await using screen = await render(view());
  const field = composer(screen);
  await userEvent.type(field, "My own question");
  await userEvent.click(screen.getByRole("button", { name: "GOAT Bot home" }));
  await userEvent.click(screen.getByRole("button", { name: "New routine" }));
  await expect.element(field).toHaveValue("My own question");
  await expect.element(field).toHaveFocus();
  expect(state.toasts).toEqual([
    "Your message box already has a message. Send or clear it, then try again.",
  ]);
  await userEvent.clear(field);
  await stageFile(screen);
  await userEvent.click(page.getByRole("tab", { name: "Library" }));
  await userEvent.click(screen.getByRole("button", { name: "Ask to forget" }));
  // The staged file stays, and nothing is drafted to travel with it.
  await expect.element(field).toHaveValue("");
  await expect.element(screen.getByText("notes.txt")).toBeVisible();
  expect(state.toasts).toHaveLength(2);
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
  await userEvent.click(page.getByRole("button", { name: "Back to chat", exact: true }));
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
