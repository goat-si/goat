import { PrimaryConnectionTarget } from "@goat/client-runtime/connection";
import type { EnvironmentThreadShell } from "@goat/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ThreadId, type ScopedThreadRef } from "@goat/contracts";
import * as Option from "effect/Option";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";
import { makeThreadFixture } from "../test-fixtures";
import { environmentCatalog } from "../connection/catalog";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import { AppAtomRegistryProvider, appAtomRegistry } from "../rpc/atomRegistry";
import { useProjects, useQuietThreadShells } from "../state/entities";
import { environmentPresentations } from "../state/presentation";
import type { Project } from "../types";
import Sidebar from "./Sidebar";
import { SortableThreadRow } from "./sidebar/SidebarThreadRow";
import { SidebarProvider } from "./ui/sidebar";

vi.mock("../state/entities", { spy: true });
vi.mock("../hooks/useHandleNewThread", { spy: true });
vi.mock("../hooks/useThreadRouteTarget", { spy: true });
vi.mock("./sidebar/SidebarThreadRow", { spy: true });
// The machines' presentations as the test sets them, like connection updates arriving.
vi.mock(import("../state/presentation"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const actual = await original();
  return {
    ...actual,
    environmentPresentations: {
      ...actual.environmentPresentations,
      presentationsAtom: Atom.make(new Map()),
    },
  };
});
vi.mock("../commandPaletteBus", () => ({
  openCommandPalette: vi.fn(),
  isCommandPaletteOpen: () => false,
}));
vi.mock("./sidebar/SidebarChrome", () => ({
  SidebarChromeHeader: () => null,
  SidebarChromeFooter: () => null,
}));

const REMOTE = EnvironmentId.make("remote-computer");

function project(id: string): Project {
  return {
    id: ProjectId.make(id),
    environmentId: EnvironmentId.make("local"),
    title: id,
    workspaceRoot: `/projects/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
  };
}

function threadShell(projectId: ProjectId, index: number): EnvironmentThreadShell {
  return makeThreadFixture({
    environmentId: EnvironmentId.make("local"),
    id: ThreadId.make(`thread-${index}`),
    projectId,
    title: `Thread ${index}`,
  });
}

/** A remote machine one step into connecting; each call is a fresh object, as each update is. */
function connectingRemote() {
  return new Map([
    [
      REMOTE,
      {
        entry: {
          target: new PrimaryConnectionTarget({
            environmentId: REMOTE,
            label: "Remote",
            httpBaseUrl: "https://remote.example.test",
            wsBaseUrl: "wss://remote.example.test",
          }),
          profile: Option.none(),
          enabled: true,
        },
        connection: { phase: "connecting", error: null, traceId: null },
        serverConfig: null,
      },
    ],
  ]);
}

it("does not re-render thread rows when another machine's connection moves a step", async () => {
  const activeProject = project("active");
  const threads = Array.from({ length: 5 }, (_, index) => threadShell(activeProject.id, index));
  const routeThreadRef: ScopedThreadRef = {
    environmentId: activeProject.environmentId,
    threadId: threads[0]!.id,
  };
  vi.mocked(useProjects).mockReturnValue([activeProject]);
  vi.mocked(useQuietThreadShells).mockReturnValue(threads);
  vi.mocked(useThreadRouteTarget).mockReturnValue({ kind: "server", threadRef: routeThreadRef });
  vi.mocked(useHandleNewThread).mockReturnValue({
    activeDraftThread: null,
    activeThread: null,
    defaultProjectRef: { environmentId: activeProject.environmentId, projectId: activeProject.id },
    defaultProjectFallbackReady: true,
    handleNewThread: vi.fn().mockResolvedValue(null),
    routeDraftId: null,
    routeThreadRef,
  });
  await using screen = await render(
    <AppAtomRegistryProvider>
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>
    </AppAtomRegistryProvider>,
  );
  await expect.element(screen.getByText("Thread 4").first()).toBeInTheDocument();
  await vi.waitFor(() => {
    expect(appAtomRegistry.get(environmentCatalog.catalogValueAtom).isReady).toBe(true);
    expect(appAtomRegistry.get(environmentCatalog.networkStatusValueAtom)).not.toBe("unknown");
  });
  const presentations = environmentPresentations.presentationsAtom as never;
  await act(() => appAtomRegistry.set(presentations, connectingRemote()));
  const rowRenders = () => vi.mocked(SortableThreadRow).mock.calls.length;

  const before = rowRenders();
  await act(() => appAtomRegistry.set(presentations, connectingRemote()));
  await act(() => appAtomRegistry.set(presentations, connectingRemote()));

  expect(
    rowRenders() - before,
    "thread rows re-rendered on another machine's connection step",
  ).toBe(0);
});
