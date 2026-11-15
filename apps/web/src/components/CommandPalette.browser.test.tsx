import { EnvironmentId, ProjectId, ThreadId } from "@goat/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { act, render } from "../../test/render";
import { openCommandPalette } from "../commandPaletteBus";
import { LAST_USED_PROJECT_STORAGE_KEY } from "../hooks/useHandleNewThread";
import { removeLocalStorageItem } from "../hooks/useLocalStorage";
import { makeThreadFixture } from "../test-fixtures";
import type { Thread } from "../types";
import type { Project } from "../types";
import { CommandPalette } from "./CommandPalette";

const state = vi.hoisted(() => ({
  projects: [] as ReadonlyArray<Project>,
  threads: [] as ReadonlyArray<Thread>,
}));
vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: () => state.projects,
  useThreadShells: () => state.threads,
}));

function setup(input: { threads?: ReadonlyArray<Thread> } = {}) {
  removeLocalStorageItem(LAST_USED_PROJECT_STORAGE_KEY);
  state.threads = input.threads ?? [];
  state.projects = [
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
    expect(page.getByRole("option", { name: /Drag this thread/ }).query()).toBeNull();
    await act(() => {
      document.dispatchEvent(pointer("pointermove", 50, window.innerHeight - 30));
      document.dispatchEvent(pointer("pointerup", 50, window.innerHeight - 30));
    });
    expect(onDrop).toHaveBeenCalledOnce();
    expect((onDrop.mock.calls[0]![0] as CustomEvent).detail).toEqual([{ environmentId, threadId }]);
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
});
