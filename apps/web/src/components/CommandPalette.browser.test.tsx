import { EnvironmentId, ProjectId } from "@goat/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { act, render } from "../../test/render";
import { openCommandPalette } from "../commandPaletteBus";
import type { Project } from "../types";
import { CommandPalette } from "./CommandPalette";

const state = vi.hoisted(() => ({ projects: [] as ReadonlyArray<Project> }));
vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: () => state.projects,
}));

function setup() {
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
