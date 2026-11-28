import appCss from "../index.css?inline";
import type { EnvironmentServerConfig } from "@goat/client-runtime/connection";
import { scopedThreadKey, scopeThreadRef } from "@goat/client-runtime/environment";
import * as shelfHooks from "../state/olderSettledShelf";
import { createWorkspaceFocusController, workspaceAreaProps } from "../lib/workspaceFocus";
import type { EnvironmentThreadShell } from "@goat/client-runtime/state/shell";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type LocalApi,
  type ScopedThreadRef,
} from "@goat/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";
import { openCommandPalette } from "../commandPaletteBus";
import { makeThreadFixture } from "../test-fixtures";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import { useProjects, useServerConfigs, useQuietThreadShells } from "../state/entities";
import { readEnvironmentScope, useEnvironmentScope } from "../state/session";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { readLocalApi } from "../localApi";
import type { Project } from "../types";
import Sidebar from "./Sidebar";
import { Sidebar as SidebarSheet, SidebarProvider, SidebarTrigger, useSidebar } from "./ui/sidebar";

vi.mock(import("../state/olderSettledShelf"), async (original) => {
  const actual = await original();
  return { ...actual, useOlderSettledShelf: vi.fn(actual.useOlderSettledShelf) };
});
vi.mock("../state/entities", { spy: true });
vi.mock("../hooks/useHandleNewThread", { spy: true });
vi.mock("../hooks/useThreadRouteTarget", { spy: true });
vi.mock("../state/session", { spy: true });
vi.mock("../state/use-orchestration-command", { spy: true });
vi.mock("../localApi", { spy: true });
vi.mock(import("../state/server"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const { compileResolvedKeybindingsConfig } = await import("@goat/shared/keybindings");
  // The desktop defaults: holding Mod alone already matches a thread jump.
  const keybindings = compileResolvedKeybindingsConfig([
    { key: "mod+1", command: "thread.jump.1" },
    { key: "mod+2", command: "thread.jump.2" },
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

describe("sidebar thread rename", () => {
  // regression: #35151 an untouched rename wrote back the title it opened with over a newer one
  it.each(["{Enter}", "{Tab}"])(
    "ending an untouched rename with %s keeps a title that arrived while it was open",
    async (finish) => {
      const activeProject = project("active");
      const routeThreadRef: ScopedThreadRef = {
        environmentId: activeProject.environmentId,
        threadId: ThreadId.make("thread-0"),
      };
      const shellTitled = (title: string) => ({ ...threadShell(activeProject.id, 0), title });
      const updateMetadata = vi.fn().mockResolvedValue({ _tag: "Success" });
      vi.mocked(useOrchestrationCommand).mockReturnValue(updateMetadata);
      vi.mocked(readEnvironmentScope).mockReturnValue(true);
      vi.mocked(useEnvironmentScope).mockReturnValue(true);
      vi.mocked(useProjects).mockReturnValue([activeProject]);
      vi.mocked(useQuietThreadShells).mockReturnValue([shellTitled("Fix the login redirect")]);
      vi.mocked(useThreadRouteTarget).mockReturnValue({
        kind: "server",
        threadRef: routeThreadRef,
      });
      vi.mocked(useHandleNewThread).mockReturnValue({
        activeDraftThread: null,
        activeThread: null,
        defaultProjectRef: {
          environmentId: activeProject.environmentId,
          projectId: activeProject.id,
        },
        defaultProjectFallbackReady: true,
        handleNewThread: vi.fn().mockResolvedValue(null),
        routeDraftId: null,
        routeThreadRef,
      });
      const tree = () => (
        <SidebarProvider>
          <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
        </SidebarProvider>
      );
      await using screen = await render(tree());
      await userEvent.dblClick(screen.getByText("Fix the login redirect").first());
      const input = screen.getByRole("textbox", { name: "Thread title" });
      await expect.element(input).toHaveValue("Fix the login redirect");

      vi.mocked(useQuietThreadShells).mockReturnValue([shellTitled("Generated title")]);
      await screen.rerender(tree());
      await userEvent.keyboard(finish);

      await expect.element(input).not.toBeInTheDocument();
      expect(updateMetadata).not.toHaveBeenCalled();
    },
  );
});

describe("sidebar thread click", () => {
  // regression: #40715 macOS counts quick clicks on different rows, so the next row got detail 2 and was ignored
  it("opens another thread when the click arrives with a double-click count", async () => {
    const activeProject = project("active");
    const threads = [threadShell(activeProject.id, 0), threadShell(activeProject.id, 1)];
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
      defaultProjectRef: {
        environmentId: activeProject.environmentId,
        projectId: activeProject.id,
      },
      defaultProjectFallbackReady: true,
      handleNewThread: vi.fn().mockResolvedValue(null),
      routeDraftId: null,
      routeThreadRef,
    });
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
      { router: "/local/thread-0" },
    );
    const navigate = vi.spyOn(screen.router!, "navigate").mockResolvedValue(undefined);

    const openRow = screen.getByText("Thread 0").first().element();
    await act(() => {
      openRow.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, detail: 2 }),
      );
    });
    expect(navigate).not.toHaveBeenCalled();

    const row = screen.getByText("Thread 1").first().element();
    await act(() => {
      row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 2 }));
    });

    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ params: expect.objectContaining({ threadId: "thread-1" }) }),
    );
  });
});

function MobileSheetProbe() {
  const { openMobile, setOpenMobile } = useSidebar();
  return (
    <button type="button" onClick={() => setOpenMobile(true)}>
      {openMobile ? "Sheet open" : "Sheet closed"}
    </button>
  );
}

async function usePhoneViewport() {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(390, 844);
  return { [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height) };
}

describe("sidebar thread menu on a phone", () => {
  it("closes the sheet when New thread on branch starts the thread", async () => {
    await using _viewport = await usePhoneViewport();
    const activeProject = project("active");
    const thread = makeThreadFixture({
      environmentId: EnvironmentId.make("local"),
      id: ThreadId.make("thread-branch"),
      projectId: activeProject.id,
      title: "Branch thread",
      branch: "feature/login",
    });
    const threadRef = { environmentId: activeProject.environmentId, threadId: thread.id };
    const show = vi.fn().mockResolvedValue("new-thread-on-branch");
    const startThread = vi.fn().mockResolvedValue(null);
    vi.mocked(readLocalApi).mockReturnValue({ contextMenu: { show } } as unknown as LocalApi);
    vi.mocked(useProjects).mockReturnValue([activeProject]);
    vi.mocked(useQuietThreadShells).mockReturnValue([thread]);
    vi.mocked(useThreadRouteTarget).mockReturnValue({ kind: "server", threadRef });
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: {
        environmentId: activeProject.environmentId,
        projectId: activeProject.id,
      },
      defaultProjectFallbackReady: true,
      handleNewThread: startThread,
      routeDraftId: null,
      routeThreadRef: threadRef,
    });
    await using screen = await render(
      <SidebarProvider>
        <MobileSheetProbe />
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Sheet closed" }));
    await expect.element(screen.getByRole("button", { name: "Sheet open" })).toBeInTheDocument();
    await userEvent.click(screen.getByText("Branch thread").first(), { button: "right" });
    await vi.waitFor(() => expect(startThread).toHaveBeenCalledTimes(1));
    expect(startThread.mock.lastCall?.[1]).toMatchObject({ branch: "feature/login" });
    await expect.element(screen.getByRole("button", { name: "Sheet closed" })).toBeInTheDocument();
  });

  it("closes the sheet when Add project opens the picker, as New thread does", async () => {
    await using _viewport = await usePhoneViewport();
    vi.mocked(useProjects).mockReturnValue([]);
    vi.mocked(useQuietThreadShells).mockReturnValue([]);
    vi.mocked(useThreadRouteTarget).mockReturnValue(null);
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: null,
      defaultProjectFallbackReady: true,
      handleNewThread: vi.fn().mockResolvedValue(null),
      routeDraftId: null,
      routeThreadRef: null,
    });
    vi.mocked(openCommandPalette).mockClear();
    await using screen = await render(
      <SidebarProvider>
        <MobileSheetProbe />
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Sheet closed" }));
    await userEvent.click(screen.getByRole("button", { name: "Add project" }));
    expect(openCommandPalette).toHaveBeenCalledExactlyOnceWith({ open: "add-project" });
    await expect.element(screen.getByRole("button", { name: "Sheet closed" })).toBeInTheDocument();
  });
});

describe("sidebar selection menu", () => {
  it("counts only the selected threads Settle will settle", async () => {
    const activeProject = project("active");
    const activeThread = threadShell(activeProject.id, 0);
    const settledThread = makeThreadFixture({
      environmentId: activeProject.environmentId,
      projectId: activeProject.id,
      id: ThreadId.make("thread-1"),
      title: "Thread 1",
      settledOverride: "settled",
      settledAt: "2026-01-01T00:00:00.000Z",
    });
    const settledRef = { environmentId: activeProject.environmentId, threadId: settledThread.id };
    const show = vi.fn().mockResolvedValue(null);
    vi.mocked(readLocalApi).mockReturnValue({ contextMenu: { show } } as unknown as LocalApi);
    vi.mocked(useProjects).mockReturnValue([activeProject]);
    vi.mocked(useQuietThreadShells).mockReturnValue([activeThread, settledThread]);
    vi.mocked(useThreadRouteTarget).mockReturnValue({ kind: "server", threadRef: settledRef });
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: {
        environmentId: activeProject.environmentId,
        projectId: activeProject.id,
      },
      defaultProjectFallbackReady: true,
      handleNewThread: vi.fn().mockResolvedValue(null),
      routeDraftId: null,
      routeThreadRef: settledRef,
    });
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    await expect.element(screen.getByText("Thread 1").first()).toBeInTheDocument();
    const selection = useThreadSelectionStore.getState();
    selection.clearSelection();
    selection.toggleThread(
      scopedThreadKey(scopeThreadRef(activeProject.environmentId, activeThread.id)),
    );
    selection.toggleThread(scopedThreadKey(settledRef));
    await userEvent.click(screen.getByText("Thread 0").first(), { button: "right" });
    await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(1));
    const settleItem = show.mock.lastCall?.[0].find((item: { id: string }) => item.id === "settle");
    expect(settleItem?.label).toBe("Settle (1)");
    selection.clearSelection();
  });
});

describe("sidebar settled pagination", () => {
  it("keeps the viewport in place when showing more settled threads", async () => {
    using stack = new DisposableStack();
    const style = document.createElement("style");
    style.textContent = appCss;
    document.head.append(style);
    stack.defer(() => style.remove());
    const focusController = createWorkspaceFocusController(document);
    stack.defer(() => focusController.dispose());
    let loading = false;
    const originalShelf = vi.mocked(shelfHooks.useOlderSettledShelf).getMockImplementation()!;
    using _shelf = vi.spyOn(shelfHooks, "useOlderSettledShelf").mockImplementation((input) => ({
      ...originalShelf(input),
      loading,
      retry: () => {
        loading = true;
      },
    }));
    const activeProject = project("active");
    const threads = Array.from({ length: 70 }, (_, index) =>
      makeThreadFixture({
        environmentId: activeProject.environmentId,
        projectId: activeProject.id,
        id: ThreadId.make(`settled-${index}`),
        title: `Settled thread ${index}`,
        settledOverride: "settled",
        settledAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    threads.unshift(threadShell(activeProject.id, 100));
    vi.mocked(useProjects).mockReturnValue([activeProject]);
    vi.mocked(useQuietThreadShells).mockReturnValue(threads);
    vi.mocked(useThreadRouteTarget).mockReturnValue({
      kind: "server",
      threadRef: { environmentId: activeProject.environmentId, threadId: threads[0]!.id },
    });
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: {
        environmentId: activeProject.environmentId,
        projectId: activeProject.id,
      },
      defaultProjectFallbackReady: true,
      handleNewThread: vi.fn().mockResolvedValue(null),
      routeDraftId: null,
      routeThreadRef: { environmentId: activeProject.environmentId, threadId: threads[0]!.id },
    });
    vi.mocked(useServerConfigs).mockReturnValue(
      new Map([
        [
          activeProject.environmentId,
          {
            scratchWorkspaceRoot: null,
            shellThreadFamilies: false,
            environment: { capabilities: { threadSettlement: true, threadSnooze: true } },
          } as unknown as EnvironmentServerConfig,
        ],
      ]),
    );
    await using screen = await render(
      <SidebarProvider
        {...workspaceAreaProps("sidebar", 0, "Threads")}
        style={{ height: 400, minHeight: 400 }}
      >
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    const shelf = screen.container.querySelector<HTMLElement>(
      '[data-sidebar-row="shelf:settled"]',
    )!;
    if (shelf.getAttribute("aria-expanded") === "false") await act(() => shelf.click());
    const more = screen.getByRole("button", { name: "Show 25 more", exact: true });
    await expect.element(more).toBeInTheDocument();
    const moreButton = more.element() as HTMLButtonElement;
    const viewport = moreButton.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
    viewport.style.height = "300px";
    viewport.style.maxHeight = "300px";
    moreButton.scrollIntoView({ block: "nearest" });
    const before = viewport.scrollTop;
    expect(before).toBeGreaterThan(0);
    moreButton.focus({ preventScroll: true });
    await act(() => moreButton.click());
    await expect
      .element(screen.getByRole("button", { name: "Loading", exact: true }))
      .toBeInTheDocument();
    await expect
      .element(screen.getByRole("button", { name: "Loading", exact: true }))
      .toHaveFocus();
    expect(viewport.scrollTop).toBe(before);
    const loadedRows = screen.container.querySelectorAll("[data-thread-item]").length;
    await act(() => moreButton.click());
    expect(screen.container.querySelectorAll("[data-thread-item]")).toHaveLength(loadedRows);
  });
});

describe("sidebar click guard in the narrow sheet", () => {
  it("refuses a press on a row that slid under it after the closed sheet opens", async () => {
    await page.viewport(390, 844);
    using stack = new DisposableStack();
    const style = document.createElement("style");
    style.textContent = appCss;
    document.head.append(style);
    stack.defer(() => style.remove());
    const activeProject = project("active");
    const shells = (indexes: readonly number[]) =>
      indexes.map((index) => threadShell(activeProject.id, index));
    const routeThreadRef: ScopedThreadRef = {
      environmentId: activeProject.environmentId,
      threadId: ThreadId.make("thread-9"),
    };
    vi.mocked(useProjects).mockReturnValue([activeProject]);
    vi.mocked(useQuietThreadShells).mockReturnValue(shells([0, 1, 2, 3]));
    vi.mocked(useThreadRouteTarget).mockReturnValue({ kind: "server", threadRef: routeThreadRef });
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: {
        environmentId: activeProject.environmentId,
        projectId: activeProject.id,
      },
      defaultProjectFallbackReady: true,
      handleNewThread: vi.fn().mockResolvedValue(null),
      routeDraftId: null,
      routeThreadRef,
    });
    const tree = () => (
      <SidebarProvider>
        <SidebarSheet>
          <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
        </SidebarSheet>
        <SidebarTrigger />
      </SidebarProvider>
    );
    await using screen = await render(tree());
    // The guard times presses with performance.now; the test moves that clock by hand.
    let now = 0;
    using _now = vi.spyOn(performance, "now").mockImplementation(() => now);

    // The list reorders while the sheet is closed, then the user opens it.
    vi.mocked(useQuietThreadShells).mockReturnValue(shells([0, 1, 2]));
    await screen.rerender(tree());
    await userEvent.click(screen.getByRole("button", { name: "Toggle Sidebar" }));
    const rows = () => Array.from(document.querySelectorAll<HTMLElement>("li[data-thread-item]"));
    await expect.poll(() => rows().length).toBe(3);
    await expect.element(page.elementLocator(rows()[1]!)).toBeVisible();
    // The pointer comes to rest on the list once the sheet has slid in.
    await userEvent.hover(page.elementLocator(rows()[1]!));
    now += 1000;

    // The top row goes away on its own, so the next one slides up under the pointer.
    const [top, next] = rows();
    const topIndex = Number(top!.dataset.threadItem!.split("thread-").pop());
    vi.mocked(useQuietThreadShells).mockReturnValue(
      shells([0, 1, 2].filter((index) => index !== topIndex)),
    );
    await screen.rerender(tree());
    await expect.poll(() => rows()[0]).toBe(next);
    const pressed = vi.fn();
    next!.addEventListener("click", pressed);

    await userEvent.click(page.elementLocator(next!));
    expect(pressed).not.toHaveBeenCalled();

    now += 500;
    await userEvent.click(page.elementLocator(next!));
    expect(pressed).toHaveBeenCalledOnce();
  });
});
