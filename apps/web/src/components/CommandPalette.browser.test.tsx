import { DraftId } from "../composerDraftStore";
import { useGlobalAgentStore } from "../globalAgentStore";
import { EnvironmentId, ProjectId, ThreadId } from "@goat/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";
import { openCommandPalette } from "../commandPaletteBus";
import { LAST_USED_PROJECT_STORAGE_KEY } from "../hooks/useHandleNewThread";
import { removeLocalStorageItem } from "../hooks/useLocalStorage";
import { makeThreadFixture } from "../test-fixtures";
import type { Thread } from "../types";
import type { Project } from "../types";
import { CommandPalette } from "./CommandPalette";
import { useThemeEditorStore } from "./settings/themeEditorStore";

const state = vi.hoisted(() => ({
  projects: [] as ReadonlyArray<Project>,
  threads: [] as ReadonlyArray<Thread>,
}));
vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: () => state.projects,
  useThreadShells: () => state.threads,
}));

function makeProject(title: string, id = title.toLowerCase().replace(/\s+/g, "-")): Project {
  return {
    environmentId: EnvironmentId.make("environment-1"),
    id: ProjectId.make(id),
    title,
    workspaceRoot: `/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function setup(input: { projects?: ReadonlyArray<Project>; threads?: ReadonlyArray<Thread> } = {}) {
  removeLocalStorageItem(LAST_USED_PROJECT_STORAGE_KEY);
  useThemeEditorStore.setState(useThemeEditorStore.getInitialState(), true);
  state.threads = input.threads ?? [];
  state.projects = input.projects ?? [
    {
      environmentId: EnvironmentId.make("environment-1"),
      id: ProjectId.make("project-1"),
      title: "Example project",
      workspaceRoot: "/example",
      repositoryIdentity: null,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ];
}

describe("CommandPalette open intents", () => {
  it("drags a searched thread into the current composer without navigating", async () => {
    const environmentId = EnvironmentId.make("remote");
    const threadId = ThreadId.make("dragged-thread");
    setup({
      threads: [makeThreadFixture({ environmentId, id: threadId, title: "Drag this thread" })],
    });
    const onDrop = vi.fn();
    await using screen = await render(
      <CommandPalette>
        <div
          data-thread-context-drop="true"
          ref={(node) => {
            node?.addEventListener("goat-thread-context-drop", onDrop);
          }}
          style={{ position: "fixed", bottom: 0, width: 300, height: 100 }}
        >
          Composer
        </div>
      </CommandPalette>,
    );
    const pathname = screen.router?.state.location.pathname;
    openCommandPalette({ query: "Drag this thread" });
    const row = page.getByRole("option", { name: /Drag this thread/ });
    await expect.element(row).toBeVisible();
    const bounds = row.element().getBoundingClientRect();
    const pointer = (type: string, x: number, y: number) =>
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        isPrimary: true,
        button: 0,
        buttons: type === "pointerup" ? 0 : 1,
        clientX: x,
        clientY: y,
      });
    await act(() => {
      row.element().dispatchEvent(pointer("pointerdown", bounds.x + 20, bounds.y + 10));
      document.dispatchEvent(pointer("pointermove", bounds.x + 30, bounds.y + 20));
    });
    await expect.element(row).not.toBeInTheDocument();
    await act(() => {
      document.dispatchEvent(pointer("pointermove", 50, window.innerHeight - 30));
      document.dispatchEvent(pointer("pointerup", 50, window.innerHeight - 30));
    });
    expect(onDrop).toHaveBeenCalledOnce();
    expect((onDrop.mock.calls[0]![0] as CustomEvent).detail).toEqual([
      { environmentId, threadId, title: "Drag this thread" },
    ]);
    expect(screen.router?.state.location.pathname).toBe(pathname);
  });

  it("focuses the search input when an open intent replaces the initial view", async () => {
    setup();
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    await act(() => openCommandPalette({ open: "new-thread-in" }));

    await expect.element(page.getByRole("button", { name: "Back", exact: true })).toBeVisible();
    const input = page.getByPlaceholder("Search...", { exact: true });
    await expect.element(input).toHaveFocus();
    await input.fill("Example");
    await expect.element(input).toHaveValue("Example");
  });

  it("opens a search intent with its query in the focused input", async () => {
    setup();
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    await act(() => openCommandPalette({ query: "example" }));

    const input = page.getByPlaceholder("Search commands, projects, and threads...");
    await expect.element(input).toHaveFocus();
    await expect.element(input).toHaveValue("example");
  });

  it("leaves a submenu only on a fresh, unmodified Backspace", async () => {
    setup({ projects: [makeProject("Acme"), makeProject("Beta")] });
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({});
    const rootInput = page.getByPlaceholder("Search commands, projects, and threads...");
    await expect.element(rootInput).toHaveFocus();
    await userEvent.click(page.getByRole("option", { name: /^New thread in\.\.\./ }));

    const submenuInput = page.getByPlaceholder("Search...");
    await expect.element(submenuInput).toHaveFocus();

    for (const init of [
      { repeat: true },
      { ctrlKey: true },
      { isComposing: true },
    ] satisfies ReadonlyArray<KeyboardEventInit>) {
      const event = new KeyboardEvent("keydown", {
        key: "Backspace",
        bubbles: true,
        cancelable: true,
        ...init,
      });
      await act(() => submenuInput.element().dispatchEvent(event));
      expect(event.defaultPrevented).toBe(false);
      await expect.element(submenuInput).toBeVisible();
    }

    await userEvent.keyboard("{Backspace}");
    await expect.element(rootInput).toHaveFocus();
  });

  it("ignores repeated Escape keydowns in file search and after stepping back", async () => {
    setup();
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({});
    const palette = page.getByTestId("command-palette");
    await expect.element(palette).toHaveAttribute("data-palette-mode", "command");

    await page.getByRole("option", { name: /^Go to file/ }).click();
    await expect.element(palette).toHaveAttribute("data-palette-mode", "files");

    const repeatInChild = new KeyboardEvent("keydown", {
      key: "Escape",
      keyCode: 27,
      repeat: true,
      bubbles: true,
      cancelable: true,
    });
    await act(() => document.activeElement?.dispatchEvent(repeatInChild));
    expect(repeatInChild.defaultPrevented).toBe(true);
    await expect.element(palette).toHaveAttribute("data-palette-mode", "files");

    await userEvent.keyboard("{Escape}");
    await expect.element(palette).toHaveAttribute("data-palette-mode", "command");
    await expect
      .element(page.getByPlaceholder("Search commands, projects, and threads..."))
      .toHaveFocus();

    await act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          repeat: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await expect.element(palette).toHaveAttribute("data-palette-mode", "command");

    await userEvent.keyboard("{Escape}");
    await expect.element(palette).not.toBeInTheDocument();
  });

  it("ignores held repeat shortcuts for overlay toggle, theme editor, and Usage", async () => {
    setup();
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    await using screen = await render(<CommandPalette>{null}</CommandPalette>);
    using navigate = vi.spyOn(screen.router!, "navigate").mockResolvedValue(undefined);

    await userEvent.keyboard("{Control>}k{/Control}");
    const palette = page.getByTestId("command-palette");
    await expect.element(palette).toBeVisible();

    const repeatToggle = new KeyboardEvent("keydown", {
      key: "k",
      ctrlKey: true,
      repeat: true,
      bubbles: true,
      cancelable: true,
    });
    await act(() => window.dispatchEvent(repeatToggle));
    expect(repeatToggle.defaultPrevented).toBe(true);
    await expect.element(palette).toBeVisible();

    for (const keys of [
      { key: "T", ctrlKey: true, altKey: true, shiftKey: true },
      { key: "u", ctrlKey: true },
    ]) {
      const event = new KeyboardEvent("keydown", {
        ...keys,
        repeat: true,
        bubbles: true,
        cancelable: true,
      });
      await act(() => window.dispatchEvent(event));
      expect(event.defaultPrevented, keys.key).toBe(true);
    }
    expect(useThemeEditorStore.getState().session).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });
});

it("omits a launched task nested under a visible parent from thread results", async () => {
  const parent = makeThreadFixture({ id: ThreadId.make("parent"), title: "Task parent" });
  const base = makeThreadFixture({ id: ThreadId.make("child"), title: "Task child" });
  const child = {
    ...base,
    source: {
      ...base.source,
      launchedBy: {
        kind: "launch" as const,
        threadId: parent.id,
        environmentId: null,
        environmentLabel: null,
        threadTitle: null,
        via: "thread_launch" as const,
      },
    },
  };
  setup({ threads: [parent, child] });
  await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
  await act(() => openCommandPalette({ query: "Task" }));
  await expect.element(page.getByRole("option", { name: /Task parent/ })).toBeVisible();
  await expect.element(page.getByRole("option", { name: /Task child/ })).not.toBeInTheDocument();
});

it("keeps a task searchable when its global-agent launcher has no sidebar row", async () => {
  const parent = makeThreadFixture({ id: ThreadId.make("global-parent"), title: "Global parent" });
  const base = makeThreadFixture({
    id: ThreadId.make("global-child"),
    title: "Task from global agent",
  });
  const child = {
    ...base,
    source: {
      ...base.source,
      launchedBy: {
        kind: "launch" as const,
        threadId: parent.id,
        environmentId: null,
        environmentLabel: null,
        threadTitle: null,
        via: "thread_launch" as const,
      },
    },
  };
  const previous = useGlobalAgentStore.getState().ref;
  useGlobalAgentStore.setState({
    ref: {
      environmentId: parent.environmentId,
      threadId: parent.id,
      draftId: DraftId.make("global-draft"),
    },
  });
  using _restore = { [Symbol.dispose]: () => useGlobalAgentStore.setState({ ref: previous }) };
  setup({ threads: [parent, child] });
  await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
  await act(() => openCommandPalette({ query: "Task from global agent" }));
  await expect.element(page.getByRole("option", { name: /Task from global agent/ })).toBeVisible();
});
