import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { BotProfile } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { act, fakeTimers, render } from "../../test/render";
import { openCommandPalette } from "../commandPaletteBus";
import "~/index.css";

const state = vi.hoisted(() => ({ read: vi.fn(), members: false }));
const decodeBot = Schema.decodeSync(BotProfile);
vi.mock("./goatBot/goatBotPaletteItems", async (original) => ({
  ...(await original<typeof import("./goatBot/goatBotPaletteItems")>()),
  useGoatBotPaletteBots: () => [
    decodeBot({
      botId: "main",
      role: "main",
      name: "Goaty",
      avatar: null,
      purpose: "",
      defaultModelSelection: null,
      defaultProjectId: null,
      environmentId: "env-1",
      sessionThreadId: "bot-thread",
      createdAt: "2026-11-07T00:00:00.000Z",
      updatedAt: "2026-11-07T00:00:00.000Z",
    }),
    ...(state.members
      ? ["New bot", "Keyboard Bot", "A11y Bot"].map((name, index) =>
          decodeBot({
            botId: `member-${index}`,
            role: "member",
            name,
            avatar: null,
            purpose: "",
            defaultModelSelection: null,
            defaultProjectId: null,
            environmentId: "env-1",
            sessionThreadId: `member-thread-${index}`,
            createdAt: "2026-11-07T00:00:00.000Z",
            updatedAt: "2026-11-07T00:00:00.000Z",
          }),
        )
      : []),
  ],
}));
vi.mock("~/state/entities", async (original) => {
  const actual = await original<typeof import("~/state/entities")>();
  return {
    ...actual,
    useServerConfigs: () => {
      const configs = new Map<string, unknown>(actual.useServerConfigs());
      configs.set("env-1", { environment: { capabilities: { goatBotTaskLookupSearch: true } } });
      return configs;
    },
  };
});
vi.mock("~/state/channels", async (original) => {
  const actual = await original<typeof import("~/state/channels")>();
  const { Atom } = await import("effect/reactivity");
  return {
    ...actual,
    channelEnvironment: {
      ...actual.channelEnvironment,
      searchBotTasks: {
        ...actual.channelEnvironment.searchBotTasks,
        permissionAtom: () => Atom.make(true),
      },
    },
  };
});
vi.mock("~/state/use-atom-command", async (original) => {
  const actual = await original<typeof import("~/state/use-atom-command")>();
  return {
    ...actual,
    useAtomCommand: (command: { label: string }, options?: unknown) =>
      command.label === "environment-data:channel:search-bot-tasks"
        ? state.read
        : actual.useAtomCommand(command as never, options as never),
  };
});
import { CommandPalette } from "./CommandPalette";

it("announces task search states and operates results with the palette keyboard", async () => {
  state.read.mockReset();
  let finish!: (value: unknown) => void;
  state.read.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await using screen = await render(<CommandPalette>{null}</CommandPalette>, { router: "/" });
  using _clock = fakeTimers();
  await act(() => openCommandPalette({ query: "zebra" }));
  await act(() => vi.advanceTimersByTimeAsync(250));
  const status = page.getByRole("status", { name: "Bot task search" });
  const statusNode = status.element();
  await vi.waitFor(() => expect(status.element().textContent).toContain("Searching tasks"));
  await act(() =>
    finish({
      _tag: "Success",
      value: {
        tasks: [
          { taskId: "task-zebra", title: "Zebra task", createdAt: "2026-11-07T00:00:00.000Z" },
        ],
        partial: true,
        nextCursor: "next",
      },
    }),
  );
  await vi.waitFor(() =>
    expect(status.element().textContent).toContain("Some results could not be checked"),
  );
  await expect
    .element(page.getByText("Some results could not be checked.", { exact: true }))
    .toBeVisible();
  await expect.element(page.getByRole("option", { name: /Zebra task/ })).toBeVisible();
  await expect.element(page.getByRole("option", { name: /Load more/ })).toBeVisible();
  state.read.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("offline"))));
  await userEvent.keyboard("{ArrowDown}{Enter}");
  await vi.waitFor(() => expect(status.element().textContent).toContain("Couldn't search tasks"));
  expect(status.element().textContent).toContain("Some results could not be checked.");
  await expect
    .element(
      page.getByText("Couldn't search tasks. Some results could not be checked.", { exact: true }),
    )
    .toBeVisible();
  await expect.element(page.getByRole("option", { name: /Zebra task/ })).toBeVisible();
  await expect.element(page.getByRole("option", { name: /Retry task search/ })).toBeVisible();
  expect(status.element()).toBe(statusNode);
  expect(state.read).toHaveBeenCalledWith({
    environmentId: "env-1",
    input: { botId: "main", query: "zebra", cursor: "next", limit: 20 },
  });
  await userEvent.keyboard("{ArrowDown}{ArrowUp}{Enter}");
  await vi.waitFor(() =>
    expect(screen.router?.state.location.search).toMatchObject({
      task: "task-zebra",
      taskTitle: "Zebra task",
    }),
  );
});

it("ignores a late task search after the palette closes", async () => {
  state.read.mockReset();
  let finish!: (value: unknown) => void;
  state.read.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await using _screen = await render(<CommandPalette>{null}</CommandPalette>, { router: "/" });
  using _clock = fakeTimers();
  using errors = vi.spyOn(console, "error");
  await act(() => openCommandPalette({ query: "zebra" }));
  await act(() => vi.advanceTimersByTimeAsync(250));
  await vi.waitFor(() => expect(state.read).toHaveBeenCalledOnce());
  await userEvent.keyboard("{Escape}");
  await act(() => finish(AsyncResult.failure(Cause.fail(new Error("offline")))));
  expect(
    page.getByRole("dialog", { name: "Command palette" }).element().hasAttribute("data-closed"),
  ).toBe(true);
  expect(page.getByRole("status", { name: "Bot task search" }).element().textContent).toBe("");
  expect(errors).not.toHaveBeenCalled();
});

it("announces empty member searches without showing them in the palette", async () => {
  state.read.mockReset();
  state.read.mockResolvedValue({ _tag: "Success", value: { tasks: [] } });
  state.members = true;
  using _members = {
    [Symbol.dispose]: () => {
      state.members = false;
    },
  };
  await using _screen = await render(<CommandPalette>{null}</CommandPalette>, { router: "/" });
  using _clock = fakeTimers();
  await act(() => openCommandPalette({ query: "checklist" }));
  await act(() => vi.advanceTimersByTimeAsync(250));
  const status = page.getByRole("status", { name: "Bot task search" });
  await vi.waitFor(() =>
    expect(status.element().textContent).toContain("A11y Bot: No matching tasks."),
  );
  expect(status.element().classList.contains("sr-only")).toBe(true);
  expect(getComputedStyle(status.element()).position).toBe("absolute");
  expect(getComputedStyle(status.element()).width).toBe("1px");
  expect(page.getByRole("option", { name: /No matching tasks/ }).query()).toBeNull();
});

it("shows when an empty task search ended early", async () => {
  state.read.mockReset();
  state.read.mockResolvedValue({ _tag: "Success", value: { tasks: [], endedEarly: true } });
  await using _screen = await render(<CommandPalette>{null}</CommandPalette>, { router: "/" });
  using _clock = fakeTimers();
  await act(() => openCommandPalette({ query: "zebra" }));
  await act(() => vi.advanceTimersByTimeAsync(250));
  await expect
    .element(
      page.getByText(
        "No matching tasks found. Some tasks could not be checked. Search ended early.",
        { exact: true },
      ),
    )
    .toBeVisible();
  const status = page.getByRole("status", { name: "Bot task search" });
  expect(status.element().textContent).toContain("Search ended early.");
});
