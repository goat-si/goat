import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import { EnvironmentId, ThreadId } from "@goat/contracts";
import { type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

import "~/index.css";

const state = vi.hoisted(() => ({
  narrow: false,
  routines: null as { tasks: unknown[] } | null,
  /** A read is out; `routines` is what the last one answered. */
  pending: false,
}));
vi.mock("../WorkspacePageHeader", () => ({
  WorkspacePageHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
}));
vi.mock("../settings/MemorySettings", () => ({ MemorySettingsEntry: () => null }));
vi.mock("./GoatBotModelPicker", () => ({ GoatBotModelPicker: () => null }));
vi.mock("./GoatBotAvatar", () => ({
  GoatBotAvatar: () => null,
  GoatBotMainAvatar: () => null,
  GoatBotSessionAvatar: () => null,
}));
vi.mock("~/hooks/useMediaQuery", () => ({ useMediaQuery: () => state.narrow }));
vi.mock("./GoatBotStatusCard", () => ({ GoatBotStatusCard: () => null }));
vi.mock("./GoatBotComputer", () => ({ GoatBotComputer: () => null }));
vi.mock("./GoatBotLibrary", () => ({ GoatBotLibrary: () => <p>Saved files</p> }));
vi.mock("./GoatBotMemory", () => ({ GoatBotMemory: () => null }));
const at = "2026-11-09T00:00:00.000Z";
vi.mock("./useBotRoster", () => ({
  useBotThreads: () => ({
    rows: [
      {
        kind: "task",
        task: { taskId: "task-a", title: "Fix the flaky test", status: "running", updatedAt: at },
        view: { taskId: "task-a", pinnedAt: null, doneAt: null, readThrough: null },
        lastActivityAt: at,
        unread: false,
        mainMessagesSinceQuiet: 0,
        worker: { environmentId: "local", threadId: "channel-worker:a" },
      },
    ],
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
  return {
    ...real,
    serverEnvironment: { ...real.serverEnvironment, scheduledTasksLive: () => "routines" },
  };
});
vi.mock("~/state/query", async (original) => ({
  ...(await original<typeof import("~/state/query")>()),
  useEnvironmentQuery: (atom: unknown) => ({
    data: atom === "routines" ? state.routines : null,
    failure: null,
    error: null,
    isPending: atom === "routines" && state.pending,
    isSuccess: true,
    refresh: () => {},
  }),
}));

import { GoatBotChatView } from "./GoatBotChatView";

const environmentId = EnvironmentId.make("local");
const routine = (id: string, title: string) => ({
  id,
  title,
  prompt: "Look over my open work",
  enabled: true,
  schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [] },
  threadId: "bot",
  nextRunAt: null,
  lastRunAt: null,
  lastRunStatus: "never",
  lastRunError: null,
});
const line = (name: string): GoatBotRow => ({
  kind: "event",
  id: "event-1",
  text: "Routine " + name + " paused",
  subject: { kind: "routine", id: "r1", name },
  createdAt: at,
  firstInGroup: true,
  groupPosition: "single",
});

function setup(routines: { tasks: unknown[] } | null) {
  state.narrow = false;
  state.routines = routines;
  state.pending = false;
}

function view(rows: ReadonlyArray<GoatBotRow>) {
  return (
    <GoatBotChatView
      availability={{ kind: "ready", bot: { environmentId, threadId: ThreadId.make("bot") } }}
      canOperate
      rows={rows}
      rowsForTask={() => []}
      onSend={() => {}}
      onRetryInput={() => {}}
      legacyAgentRoute={null}
    />
  );
}

it("a routine chip clicked while Library shows lands on Home with that routine focused", async () => {
  setup({ tasks: [routine("r2", "Daily digest"), routine("r1", "Check in")] });
  await using screen = await render(view([line("Check in")]));
  await userEvent.click(screen.getByRole("button", { name: "GOAT Bot home" }));
  await userEvent.click(page.getByRole("tab", { name: "Library" }));
  await expect.element(page.getByText("Saved files")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Open routine Check in" }));
  await expect
    .element(page.getByRole("tab", { name: "Home" }))
    .toHaveAttribute("aria-selected", "true");
  await expect.element(page.getByRole("link", { name: /^Check in/ })).toHaveFocus();
});

it("a chip with a shortened name closes an open task view and lands on its routine by id", async () => {
  const title = "Look over every open pull request, the deploy queue and the failing nightly runs";
  setup({ tasks: [routine("r1", title), routine("r2", "Look over every open pull")] });
  await using screen = await render(view([line("Look over every open pull…")]));
  await userEvent.click(screen.getByRole("button", { name: "GOAT Bot home" }));
  await userEvent.click(page.getByRole("button", { name: /^Fix the flaky test/ }));
  await expect.element(page.getByRole("tab", { name: "Home" })).not.toBeInTheDocument();
  await userEvent.click(
    screen.getByRole("button", { name: "Open routine Look over every open pull…" }),
  );
  await expect
    .element(page.getByRole("tab", { name: "Home" }))
    .toHaveAttribute("aria-selected", "true");
  await expect.element(page.getByRole("link", { name: new RegExp("^" + title) })).toHaveFocus();
});

it("a routine the loaded list no longer has is plain text; while the list loads the chip still opens Home", async () => {
  setup(null);
  await using screen = await render(view([line("Check in")]));
  await userEvent.click(screen.getByRole("button", { name: "Open routine Check in" }));
  await expect
    .element(page.getByRole("tab", { name: "Home" }))
    .toHaveAttribute("aria-selected", "true");
  setup({ tasks: [routine("r2", "Daily digest")] });
  await screen.rerender(view([line("Check in")]));
  await expect.element(screen.getByRole("note")).toHaveTextContent("Routine Check in paused");
  await expect
    .element(screen.getByRole("button", { name: "Open routine Check in" }))
    .not.toBeInTheDocument();
});

it("on a narrow screen a routine chip opens the sheet on Home with that routine focused", async () => {
  setup({ tasks: [routine("r2", "Daily digest"), routine("r1", "Check in")] });
  state.narrow = true;
  await using screen = await render(view([line("Check in")]));
  await userEvent.click(screen.getByRole("button", { name: "Open routine Check in" }));
  await expect
    .element(page.getByRole("tab", { name: "Home" }))
    .toHaveAttribute("aria-selected", "true");
  await expect.element(page.getByRole("link", { name: /^Check in/ })).toHaveFocus();
  // The sheet's own initial focus runs as it opens; the row keeps focus once it has opened.
  await expect.element(page.getByRole("dialog")).not.toHaveAttribute("data-starting-style");
  expect(document.activeElement?.textContent).toMatch(/^Check in/);
});

it("on a narrow screen a routine list that arrives after the sheet opened still lands on the routine", async () => {
  setup(null);
  state.narrow = true;
  await using screen = await render(view([line("Check in")]));
  await userEvent.click(screen.getByRole("button", { name: "Open routine Check in" }));
  await expect
    .element(page.getByRole("tab", { name: "Home" }))
    .toHaveAttribute("aria-selected", "true");
  await expect.element(page.getByRole("dialog")).not.toHaveAttribute("data-starting-style");
  setup({ tasks: [routine("r1", "Check in")] });
  state.narrow = true;
  await screen.rerender(view([line("Check in")]));
  await expect.element(page.getByRole("link", { name: /^Check in/ })).toHaveFocus();
});

it("a routine list that arrives after the person moved on leaves their focus where it is", async () => {
  setup(null);
  await using screen = await render(view([line("Check in")]));
  await userEvent.click(screen.getByRole("button", { name: "Open routine Check in" }));
  await expect
    .element(page.getByRole("tab", { name: "Home" }))
    .toHaveAttribute("aria-selected", "true");
  const composer = screen.getByRole("textbox", { name: /Message/ });
  await userEvent.click(composer);
  setup({ tasks: [routine("r1", "Check in")] });
  await screen.rerender(view([line("Check in")]));
  await expect.element(page.getByRole("link", { name: /^Check in/ })).toBeVisible();
  await expect.element(composer).toHaveFocus();
});

it("a routine deleted before its list arrives leaves no landing waiting for a later list", async () => {
  setup(null);
  await using screen = await render(view([line("Check in")]));
  await userEvent.click(screen.getByRole("button", { name: "Open routine Check in" }));
  setup({ tasks: [routine("r2", "Daily digest")] });
  await screen.rerender(view([line("Check in")]));
  await expect.element(page.getByRole("link", { name: /^Daily digest/ })).toBeVisible();
  // A later list that has it again, as one more update, moves no focus.
  setup({ tasks: [routine("r2", "Daily digest"), routine("r1", "Check in")] });
  await screen.rerender(view([line("Check in")]));
  await expect.element(page.getByRole("link", { name: /^Check in/ })).toBeVisible();
  expect(document.activeElement?.textContent ?? "").not.toMatch(/^Check in/);
});

it("a refresh holding an older list keeps the chip live until a settled list lacks the routine", async () => {
  setup({ tasks: [routine("r2", "Daily digest")] });
  state.pending = true;
  await using screen = await render(view([line("Check in")]));
  await expect.element(screen.getByRole("button", { name: "Open routine Check in" })).toBeVisible();
  state.pending = false;
  await screen.rerender(view([line("Check in")]));
  await expect
    .element(screen.getByRole("button", { name: "Open routine Check in" }))
    .not.toBeInTheDocument();
});
