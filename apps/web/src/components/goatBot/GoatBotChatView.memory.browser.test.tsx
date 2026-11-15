import type { GoatBotRow, GoatBotTaskCard } from "@goat/client-runtime/goatBot";
import {
  BotId,
  ChannelTaskId,
  type BotProfile,
  EnvironmentId,
  goatBotChangeNoteMessage,
  goatBotForgetNoteMessage,
  ThreadId,
} from "@goat/contracts";
import { AsyncResult } from "effect/reactivity";
import { type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { dismissContextMenu } from "~/contextMenuFallback";
import { observeResize } from "~/lib/observeResize";

import "~/index.css";

const state = vi.hoisted(() => ({
  narrow: false,
  threads: [] as ReadonlyArray<unknown>,
  toasts: [] as string[],
  notes: [] as Array<{ index: number; date: string | null; text: string }>,
  refresh: vi.fn(),
  routines: { tasks: [] as unknown[] },
  runNow: vi.fn(),
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
    chips: new Map(),
    refresh: () => {},
  }),
}));
vi.mock("~/state/server", async (original) => {
  const real = await original<typeof import("~/state/server")>();
  const { Atom } = await import("effect/reactivity");
  return {
    ...real,
    serverEnvironment: {
      ...real.serverEnvironment,
      scheduledTasksLive: () => "routines",
      runScheduledTaskNow: {
        permissionAtom: () => Atom.make(true),
        testExecute: (...args: unknown[]) => state.runNow(...args),
      },
    },
  };
});
// Commands this file drives carry the mock they run; every other command answers success.
vi.mock("~/state/use-atom-command", async () => {
  const { AsyncResult } = await import("effect/reactivity");
  return {
    useAtomCommand: (command: { testExecute?: unknown }) =>
      command.testExecute ?? (async () => AsyncResult.success({})),
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
              data: state.routines,
              failure: null,
              error: null,
              isPending: false,
              isSuccess: true,
              refresh: () => {},
            },
}));

import { GoatBotChatView } from "./GoatBotChatView";
import { GoatBotChatCanHide, GoatBotChatHidden } from "./goatBotLayout";
import { GoatBotMemberContext } from "./goatBotMemberContext";
import { goatBotHomeKey } from "./goatBotHomeRequest";

const note = { index: 0, date: "2026-11-07", text: 'Reply in "Korean"' };
const environmentId = EnvironmentId.make("local");

function setup(narrow = false) {
  state.narrow = narrow;
  state.threads = [];
  state.toasts = [];
  state.notes = [note];
  state.refresh.mockReset();
  state.routines = { tasks: [] };
  state.runNow.mockReset();
  const onSend = vi.fn<(text: string) => void>();
  const view = (
    rows: GoatBotRow[] = [],
    peek = false,
    openHome: { key: string; entry: string; taskId?: ChannelTaskId } | null = null,
    onHomeHandled?: () => void,
    hidden = false,
    taskRoute = false,
  ) => (
    // Home docks only in a chat view of 752px or more; the 980px window gate is faked above. The
    // route hides the chat this way while a task replaces it.
    <div style={{ width: 1200 }} hidden={hidden}>
      <GoatBotChatHidden value={hidden}>
        <GoatBotChatCanHide value={taskRoute}>
          <GoatBotChatView
            openHome={openHome}
            onHomeHandled={onHomeHandled}
            availability={{ kind: "ready", bot: { environmentId, threadId: ThreadId.make("bot") } }}
            canOperate
            rows={rows}
            onSend={onSend}
            onRetryInput={() => {}}
            legacyAgentRoute={null}
            attachmentSupport={{ maxUploadBytes: 1_000_000 }}
            rowsForTask={peek ? () => [] : undefined}
          />
        </GoatBotChatCanHide>
      </GoatBotChatHidden>
    </div>
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

it("an Open Home request for this bot opens Home once per history entry", async () => {
  const { view } = setup();
  const request = (key: string, entry: string) => ({ key, entry });
  const mine = goatBotHomeKey(environmentId, null);
  await using screen = await render(
    view([], false, request(goatBotHomeKey(EnvironmentId.make("other"), null), "a")),
  );
  const chip = screen.getByRole("button", { name: "GOAT Bot home" });
  await expect.element(chip).toHaveAttribute("aria-expanded", "false");
  await screen.rerender(view([], false, request(mine, "b")));
  await expect.element(chip).toHaveAttribute("aria-expanded", "true");
  await userEvent.click(chip);
  await expect.element(chip).toHaveAttribute("aria-expanded", "false");
  await screen.rerender(view([], false, request(mine, "b")));
  await expect.element(chip).toHaveAttribute("aria-expanded", "false");
  await screen.rerender(view([], false, null));
  await expect.element(chip).toHaveAttribute("aria-expanded", "false");
});

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

it("at 390 px Escape closes a task's Actions menu and leaves the home sheet open, focus back on Actions", async () => {
  const { view } = setup(true);
  await using _window = await windowSize(390, 844);
  const at = "2026-11-09T00:00:00.000Z";
  state.threads = [
    {
      kind: "task",
      task: { taskId: "task-a", title: "Fix the flaky test", status: "completed", updatedAt: at },
      view: { taskId: "task-a", pinnedAt: null, doneAt: null, readThrough: null },
      lastActivityAt: at,
      unread: true,
      mainMessagesSinceQuiet: 0,
      worker: { environmentId: "local", threadId: "channel-worker:a" },
    },
  ];
  await using screen = await render(view([], true));
  using _menu = { [Symbol.dispose]: dismissContextMenu };
  await userEvent.click(screen.getByRole("button", { name: "GOAT Bot home" }));
  await expect.element(homeSheet()).toBeVisible();
  const actions = page.getByRole("button", { name: "Actions for Fix the flaky test" });
  actions.element().focus();
  await userEvent.keyboard("{Enter}");
  const showWork = page.getByRole("menuitem", { name: "Show work" });
  await expect.element(showWork).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(showWork).not.toBeInTheDocument();
  await expect.element(actions).toHaveFocus();
  // Still open, not merely visible while an exit transition runs.
  await expect.element(homeSheet()).toHaveAttribute("data-open");
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

it("a task-origin request opens Home with its row marked once", async () => {
  const { view } = setup();
  const at = "2026-11-09T00:00:00.000Z";
  state.threads = [
    {
      kind: "task",
      task: { taskId: "task-a", title: "Returned task", status: "running", updatedAt: at },
      view: { taskId: "task-a", pinnedAt: null, doneAt: null, readThrough: null },
      lastActivityAt: at,
      unread: false,
      mainMessagesSinceQuiet: 0,
    },
  ];
  const request = {
    key: goatBotHomeKey(environmentId, null),
    entry: "return-entry",
    taskId: ChannelTaskId.make("task-a"),
  };
  const onHomeHandled = vi.fn();
  await using screen = await render(view([], false, request, onHomeHandled));
  await vi.waitFor(() => expect(onHomeHandled).toHaveBeenCalledOnce());
  const chip = screen.getByRole("button", { name: "GOAT Bot home" });
  await expect.element(chip).toHaveAttribute("aria-expanded", "true");
  const row = screen.getByRole("link", { name: /^Returned task/ });
  await expect.element(row).toBeVisible();
  expect(row.element().closest("[data-home-return]")?.getAttribute("data-home-return")).toBe(
    "true",
  );
  await userEvent.click(chip);
  await screen.rerender(view([], false, request));
  await expect.element(chip).toHaveAttribute("aria-expanded", "false");
  await userEvent.click(chip);
  await expect.element(screen.getByRole("link", { name: /^Returned task/ })).toBeVisible();
  expect(
    screen
      .getByRole("link", { name: /^Returned task/ })
      .element()
      .closest("[data-home-return]"),
  ).toBeNull();
  await screen.rerender(<div />);
  await screen.rerender(view([], false, null));
  await expect
    .element(screen.getByRole("button", { name: "GOAT Bot home" }))
    .toHaveAttribute("aria-expanded", "false");
});

it("opens the named member's Home for that member's task-origin request", async () => {
  const { view } = setup();
  const member = {
    botId: BotId.make("member"),
    name: "Research",
    avatar: null,
    purpose: "",
    environmentId,
    sessionThreadId: ThreadId.make("member-session"),
  } as unknown as BotProfile;
  const at = "2026-11-09T00:00:00.000Z";
  state.threads = [
    {
      kind: "task",
      task: { taskId: "task-m", title: "Member task", status: "running", updatedAt: at },
      view: { taskId: "task-m", pinnedAt: null, doneAt: null, readThrough: null },
      lastActivityAt: at,
      unread: false,
      mainMessagesSinceQuiet: 0,
    },
  ];
  const request = {
    key: goatBotHomeKey(environmentId, member.botId),
    entry: "member-return",
    taskId: ChannelTaskId.make("task-m"),
  };
  await using screen = await render(
    <GoatBotMemberContext value={member}>{view([], false, request)}</GoatBotMemberContext>,
  );
  await expect
    .element(screen.getByRole("button", { name: "Research home" }))
    .toHaveAttribute("aria-expanded", "true");
  const row = screen.getByRole("link", { name: /^Member task/ });
  await expect.element(row).toBeVisible();
  expect(row.element().closest("[data-home-return]")?.getAttribute("data-home-return")).toBe(
    "true",
  );
});

const dockedHome = (screen: Awaited<ReturnType<typeof render>>) =>
  screen.getByRole("complementary", { name: "GOAT Bot work" });
/** The frame view() renders the chat view in; its width is the chat view's width. */
const chatFrame = (screen: Awaited<ReturnType<typeof render>>) =>
  screen.container.firstElementChild as HTMLElement;

/** Resolves once the shared resize observer delivered the frame's new width to every subscriber. */
async function resizeFrame(frame: HTMLElement, width: number) {
  let resized = () => {};
  const delivered = new Promise<void>((resolve) => (resized = resolve));
  const stop = observeResize(frame, () => resized());
  try {
    // A new subscription first receives the current size; the width change comes after it.
    await delivered;
    const changed = new Promise<void>((resolve) => (resized = resolve));
    frame.style.width = `${width}px`;
    await changed;
  } finally {
    stop();
  }
}

it("Home opened in a 751px chat view stays the sheet while the view widens, and docks when reopened", async () => {
  const { view } = setup();
  await using screen = await render(view());
  await resizeFrame(chatFrame(screen), 751);
  const chip = screen.getByRole("button", { name: "GOAT Bot home" });
  await userEvent.click(chip);
  await expect.element(homeSheet()).toBeVisible();
  expect(dockedHome(screen).query()).toBeNull();
  await resizeFrame(chatFrame(screen), 1200);
  await expect.element(homeSheet()).toBeVisible();
  expect(dockedHome(screen).query()).toBeNull();
  await userEvent.keyboard("{Escape}");
  await expect.element(homeSheet()).not.toBeInTheDocument();
  await userEvent.click(chip);
  await expect.element(dockedHome(screen)).toBeVisible();
  expect(homeSheet().query()).toBeNull();
});

it("a chat hidden behind a task presents an open Home nowhere, and docks it again when shown", async () => {
  const { view } = setup();
  const request = { key: goatBotHomeKey(environmentId, null), entry: "hidden-entry" };
  await using screen = await render(view([], false, request, undefined, true));
  // The chat is hidden, so its chip is read from the page, not by role.
  await vi.waitFor(() =>
    expect(
      screen.container
        .querySelector('button[aria-label="GOAT Bot home"]')
        ?.getAttribute("aria-expanded"),
    ).toBe("true"),
  );
  expect(dockedHome(screen).query()).toBeNull();
  expect(homeSheet().query()).toBeNull();
  await screen.rerender(view([], false, request, undefined, false));
  await expect.element(dockedHome(screen)).toBeVisible();
  expect(homeSheet().query()).toBeNull();
});

it("Home reopened by Back at a wide width is docked by the first paint and never mounts the sheet", async () => {
  const { view } = setup();
  const at = "2026-11-09T00:00:00.000Z";
  state.threads = [
    {
      kind: "task",
      task: { taskId: "task-a", title: "Returned task", status: "running", updatedAt: at },
      view: { taskId: "task-a", pinnedAt: null, doneAt: null, readThrough: null },
      lastActivityAt: at,
      unread: false,
      mainMessagesSinceQuiet: 0,
    },
  ];
  const sheets: Element[] = [];
  const collect = (records: MutationRecord[]) => {
    for (const record of records)
      for (const node of record.addedNodes)
        if (
          node instanceof Element &&
          node.matches('[data-slot="sheet-popup"], :has([data-slot="sheet-popup"])')
        )
          sheets.push(node);
  };
  const watcher = new MutationObserver(collect);
  watcher.observe(document.body, { childList: true, subtree: true });
  using _watcher = { [Symbol.dispose]: () => watcher.disconnect() };
  const request = {
    key: goatBotHomeKey(environmentId, null),
    entry: "back-entry",
    taskId: ChannelTaskId.make("task-a"),
  };
  await using screen = await render(view([], false, request));
  // Read at once, not retried: render() returns after React committed, before the next frame.
  expect(screen.container.querySelector('aside[aria-label="GOAT Bot work"]')).not.toBeNull();
  const row = screen.getByRole("link", { name: /^Returned task/ });
  await expect.element(row).toBeVisible();
  expect(row.element().closest("[data-home-return]")?.getAttribute("data-home-return")).toBe(
    "true",
  );
  collect(watcher.takeRecords());
  expect(sheets).toEqual([]);
});

it("an open Home keeps the presentation it opened in while the chat view narrows and widens", async () => {
  const { view } = setup();
  await using screen = await render(view());
  const chip = screen.getByRole("button", { name: "GOAT Bot home" });
  await userEvent.click(chip);
  await expect.element(dockedHome(screen)).toBeVisible();
  const shown: string[] = [];
  for (const width of [1000, 800, 760, 752, 751, 740, 600, 751, 752, 900]) {
    await resizeFrame(chatFrame(screen), width);
    const docked = screen.container.querySelector('aside[aria-label="GOAT Bot work"]') !== null;
    const sheet = document.querySelector('[data-slot="sheet-popup"]') !== null;
    shown.push(`${width}:${docked ? "docked" : sheet ? "sheet" : "none"}`);
  }
  expect(chip.element().isConnected).toBe(true);
  expect(shown).toEqual([
    "1000:docked",
    "800:docked",
    "760:docked",
    "752:docked",
    "751:docked",
    "740:docked",
    "600:docked",
    "751:docked",
    "752:docked",
    "900:docked",
  ]);
});

const failedRoutine = {
  id: "r1",
  title: "Daily digest",
  prompt: "Summarize my day",
  enabled: true,
  schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [] },
  threadId: "bot",
  nextRunAt: null,
  lastRunAt: "2026-11-09T00:00:00.000Z",
  lastRunStatus: "failed",
  lastRunError: "The provider was offline",
};

it("a docked Home stays mounted while a task hides the chat, keeping a typed wording and a pending Run now", async () => {
  const { view } = setup();
  state.routines = { tasks: [failedRoutine] };
  let finish = (_result: unknown) => {};
  state.runNow.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
  await using screen = await render(view());
  await openMemory(screen);
  await userEvent.click(screen.getByRole("button", { name: "Ask to change" }));
  await userEvent.fill(screen.getByRole("textbox", { name: "New wording" }), "Reply in English");
  await screen.rerender(view([], false, null, undefined, true));
  await screen.rerender(view());
  await expect
    .element(screen.getByRole("textbox", { name: "New wording" }))
    .toHaveValue("Reply in English");
  await userEvent.click(screen.getByRole("tab", { name: "Home" }));
  await userEvent.click(screen.getByRole("button", { name: "Run now" }));
  await screen.rerender(view([], false, null, undefined, true));
  await screen.rerender(view());
  await expect.element(screen.getByRole("button", { name: "Run now" })).toBeDisabled();
  expect(state.runNow).toHaveBeenCalledTimes(1);
  await act(() => finish(AsyncResult.success({})));
  await expect.element(screen.getByRole("button", { name: "Run now" })).toBeEnabled();
});

it("crossing the 980px window gate while the chat is hidden opens no sheet over the task", async () => {
  const { view } = setup();
  await using screen = await render(view([], false, null, undefined, false, true));
  await userEvent.click(screen.getByRole("button", { name: "GOAT Bot home" }));
  await expect.element(dockedHome(screen)).toBeVisible();
  // The window query flips in the same render as the task route hides the chat.
  state.narrow = true;
  await screen.rerender(view([], false, null, undefined, true, true));
  expect(homeSheet().query()).toBeNull();
  // Docked Home is still there, hidden with the chat, holding what it had.
  expect(screen.container.querySelector('aside[aria-label="GOAT Bot work"]')).not.toBeNull();
});

it("on the bot's own chat, crossing the 980px window gate moves an open Home to its sheet, as before (guard)", async () => {
  const { view } = setup();
  await using screen = await render(view());
  await userEvent.click(screen.getByRole("button", { name: "GOAT Bot home" }));
  await expect.element(dockedHome(screen)).toBeVisible();
  state.narrow = true;
  await screen.rerender(view());
  await expect.element(homeSheet()).toBeVisible();
  expect(dockedHome(screen).query()).toBeNull();
});

it("Home in its sheet over the task asks nothing of the hidden composer: its draft actions are off", async () => {
  const { view } = setup();
  await using screen = await render(view([], false, null, undefined, false, true));
  await resizeFrame(chatFrame(screen), 751);
  await openMemory(screen);
  await expect.element(page.getByRole("button", { name: "Ask to change" })).toBeEnabled();
  await screen.rerender(view([], false, null, undefined, true, true));
  // The sheet stays open over the task; what it would put in the message box cannot be seen.
  await expect.element(homeSheet()).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Ask to change" })).toBeDisabled();
  await expect.element(page.getByRole("button", { name: "Ask to forget" })).toBeDisabled();
  await screen.rerender(view([], false, null, undefined, false, true));
  await expect.element(page.getByRole("button", { name: "Ask to change" })).toBeEnabled();
});

/** The interface font size, as Settings > Appearance sets it on the root; restored on dispose. */
function interfaceFontSize(px: number): Disposable {
  const before = document.documentElement.style.fontSize;
  document.documentElement.style.fontSize = `${px}px`;
  return {
    [Symbol.dispose]: () => {
      document.documentElement.style.fontSize = before;
    },
  };
}

it("at a 20px interface size Home docks only in a 940px chat view, where it is 440px and the chat keeps 500px", async () => {
  using _font = interfaceFontSize(20);
  const { view } = setup();
  await using screen = await render(view());
  const chip = screen.getByRole("button", { name: "GOAT Bot home" });
  await resizeFrame(chatFrame(screen), 939);
  await userEvent.click(chip);
  await expect.element(homeSheet()).toBeVisible();
  expect(dockedHome(screen).query()).toBeNull();
  await userEvent.keyboard("{Escape}");
  await expect.element(homeSheet()).not.toBeInTheDocument();
  await resizeFrame(chatFrame(screen), 940);
  await userEvent.click(chip);
  await expect.element(dockedHome(screen)).toBeVisible();
  const home = dockedHome(screen).element().getBoundingClientRect().width;
  expect(home).toBe(440);
  expect(940 - home).toBe(500);
});

it("a change of the interface size is measured again before Home next opens", async () => {
  const { view } = setup();
  await using screen = await render(view());
  await resizeFrame(chatFrame(screen), 900);
  const before = document.documentElement.style.fontSize;
  using _restore = {
    [Symbol.dispose]: () => {
      document.documentElement.style.fontSize = before;
    },
  };
  // Docks at 16px (900 >= 752); at 20px Home needs 940.
  await act(() => {
    document.documentElement.style.fontSize = "20px";
  });
  await userEvent.click(screen.getByRole("button", { name: "GOAT Bot home" }));
  await expect.element(homeSheet()).toBeVisible();
  expect(dockedHome(screen).query()).toBeNull();
});
