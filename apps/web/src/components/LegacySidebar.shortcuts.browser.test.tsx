import type { EnvironmentThreadShell } from "@goat/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ThreadId, type ScopedThreadRef } from "@goat/contracts";
import { isMacPlatform } from "@goat/shared/keybindings";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import { useRightPanelStore } from "../rightPanelStore";
import {
  readEnvironmentSupportsServerBrowser,
  useProjects,
  useThreadShells,
  useThreadShellsForProjectRefs,
} from "../state/entities";
import { makeThreadFixture } from "../test-fixtures";
import type { Project } from "../types";
import LegacySidebar from "./LegacySidebar";
import { SidebarProvider } from "./ui/sidebar";

vi.mock("../state/entities", { spy: true });
vi.mock("../hooks/useThreadRouteTarget", { spy: true });
vi.mock(import("../state/server"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const { compileResolvedKeybindingsConfig } = await import("@goat/shared/keybindings");
  // A custom binding that only applies while the route thread shows its preview.
  const keybindings = compileResolvedKeybindingsConfig([
    { key: "mod+2", command: "thread.jump.2", when: "previewOpen" },
  ]);
  return { ...(await original()), primaryServerKeybindingsAtom: Atom.make(keybindings) };
});
vi.mock("../commandPaletteBus", () => ({
  openCommandPalette: vi.fn(),
  isCommandPaletteOpen: () => false,
}));
vi.mock("./sidebar/SidebarChrome", () => ({
  SidebarChromeHeader: () => null,
  SidebarChromeFooter: () => null,
}));

const environmentId = EnvironmentId.make("local");
const project: Project = {
  id: ProjectId.make("active"),
  environmentId,
  title: "active",
  workspaceRoot: "/projects/active",
  repositoryIdentity: null,
  defaultModelSelection: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  scripts: [],
};

function threadShell(index: number): EnvironmentThreadShell {
  return makeThreadFixture({
    environmentId,
    id: ThreadId.make(`thread-${index}`),
    projectId: project.id,
    title: `Thread ${index}`,
  });
}

describe("legacy sidebar shortcuts", () => {
  it("runs a jump bound to previewOpen only while the route thread shows its preview", async () => {
    using stack = new DisposableStack();
    const threads = [threadShell(0), threadShell(1)];
    const routeThreadRef: ScopedThreadRef = { environmentId, threadId: threads[0]!.id };
    vi.mocked(useProjects).mockReturnValue([project]);
    vi.mocked(useThreadShells).mockReturnValue(threads);
    vi.mocked(useThreadShellsForProjectRefs).mockReturnValue(threads);
    vi.mocked(readEnvironmentSupportsServerBrowser).mockReturnValue(true);
    vi.mocked(useThreadRouteTarget).mockReturnValue({ kind: "server", threadRef: routeThreadRef });
    const panelsBefore = useRightPanelStore.getState();
    stack.defer(() => useRightPanelStore.setState(panelsBefore, true));
    await using screen = await render(
      <SidebarProvider>
        <LegacySidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    await expect.element(screen.getByText("Thread 1").first()).toBeInTheDocument();
    const modifier = isMacPlatform(navigator.platform) ? "Meta" : "Control";
    const path = () => screen.router!.state.location.pathname;
    const before = path();

    await userEvent.keyboard(`{${modifier}>}2{/${modifier}}`);
    expect(path()).toBe(before);

    await act(() => useRightPanelStore.getState().open(routeThreadRef, "preview"));
    await userEvent.keyboard(`{${modifier}>}2{/${modifier}}`);
    await vi.waitFor(() => expect(path()).toMatch(/^\/local\/thread-/));
  });
});
