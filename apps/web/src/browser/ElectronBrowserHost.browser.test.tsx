import { scopeThreadRef } from "@goat/client-runtime/environment";
import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  ThreadId,
  type ClientSettings,
  type DesktopPreviewBridge,
  type PreviewSessionSnapshot,
} from "@goat/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../test/render";

const mocks = vi.hoisted(() => ({
  getClientSettings: vi.fn<() => Promise<ClientSettings | null>>(),
  setClientSettings: vi.fn<(settings: ClientSettings) => Promise<void>>(),
  createTab: vi.fn<DesktopPreviewBridge["createTab"]>(),
  closeTab: vi.fn<DesktopPreviewBridge["closeTab"]>(),
  registerWebview: vi.fn<DesktopPreviewBridge["registerWebview"]>(),
  getPreviewConfig: vi.fn<DesktopPreviewBridge["getPreviewConfig"]>(),
  threadRunStatus: "idle" as "idle" | "running" | "subagents",
}));

vi.mock(import("~/env"), async (original) => ({ ...(await original()), isElectron: true }));

vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
}));

vi.mock(import("~/localApi"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    ensureLocalApi: () => ({ ...actual.ensureLocalApi(), persistence: mocks as never }),
  };
});

// The Electron desktop bridge; a browser has none.
vi.mock(import("~/components/preview/previewBridge"), async (original) => ({
  ...(await original()),
  previewBridge: {
    createTab: mocks.createTab,
    closeTab: mocks.closeTab,
    registerWebview: mocks.registerWebview,
    getPreviewConfig: mocks.getPreviewConfig,
  } as never,
}));

vi.mock(import("~/components/preview/usePreviewBridge"), async (original) => ({
  ...(await original()),
  usePreviewBridge: () => undefined,
}));

// Whether the tab's thread runs a turn, as its thread shell reports it.
vi.mock(import("~/state/entities"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await original()),
    useThreadShell: () =>
      useSyncExternalStore(
        (listener) => {
          runListeners.add(listener);
          return () => runListeners.delete(listener);
        },
        () => runtimeShells[mocks.threadRunStatus],
      ) as never,
  };
});
const runListeners = new Set<() => void>();
const shell = (status: string, pendingBackgroundTasks: ReadonlyArray<unknown> = []) => ({
  runtime: { status, activeRunId: null },
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  pendingSubagentRequest: null,
  pendingBackgroundTasks,
});
const runtimeShells = {
  idle: shell("idle"),
  running: shell("running"),
  // The turn ended, but its subagents work on with the thread's credential.
  subagents: shell("idle", [{ kind: "subagent", id: "child-1" }]),
};

// This desktop's own environment, whose server tabs it draws in webviews.
vi.mock(import("~/state/primaryEnvironment"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  return {
    ...(await original()),
    primaryEnvironmentIdAtom: Atom.make("host-webview-order") as never,
  };
});

import {
  __resetClientSettingsPersistenceForTests,
  ensureClientSettingsHydrated,
} from "~/hooks/useSettings";
import { reconcilePreviewServerSessions, resetPreviewStateForTests } from "~/previewStateStore";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { useBrowserSurfaceStore } from "./browserSurfaceStore";
import { ElectronBrowserHost } from "./ElectronBrowserHost";
import { previewRuntimeTabId } from "./previewRuntimeTabId";

const threadRef = scopeThreadRef(
  EnvironmentId.make("host-webview-order"),
  ThreadId.make("thread-webview-order"),
);

const snapshot = (tabId: string, updatedAt: string): PreviewSessionSnapshot => ({
  threadId: threadRef.threadId,
  tabId,
  navStatus: { _tag: "Success", url: `https://example.com/${tabId}`, title: tabId },
  canGoBack: false,
  canGoForward: false,
  updatedAt,
});

function setup(): Disposable {
  __resetClientSettingsPersistenceForTests();
  mocks.getClientSettings.mockReset().mockResolvedValue(DEFAULT_CLIENT_SETTINGS);
  mocks.setClientSettings.mockReset().mockResolvedValue(undefined);
  mocks.createTab.mockReset().mockResolvedValue(undefined);
  mocks.closeTab.mockReset().mockResolvedValue(undefined);
  mocks.registerWebview.mockReset().mockResolvedValue(undefined);
  mocks.getPreviewConfig.mockReset().mockResolvedValue({
    partition: "persist:t3-preview-default",
    webPreferences: "contextIsolation=yes",
    preloadUrl: null,
  });
  return {
    [Symbol.dispose]() {
      resetPreviewStateForTests();
      __resetClientSettingsPersistenceForTests();
    },
  };
}

async function renderHost() {
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(
    await render(
      <AppAtomRegistryProvider>
        <ElectronBrowserHost />
      </AppAtomRegistryProvider>,
    ),
  );
  // Unmounting releases each tab on a close timer; run it now so it never fires in a later test.
  stack.defer(async () => {
    using _timers = fakeTimers();
    await screen.unmount();
    await vi.advanceTimersByTimeAsync(0);
  });
  await act(() => ensureClientSettingsHydrated());
  const environment = stack.move();
  return { container: screen.container, [Symbol.asyncDispose]: () => environment.disposeAsync() };
}

describe("ElectronBrowserHost", () => {
  it("never moves a tab's webview when the server reorders tabs by last update", async () => {
    using _state = setup();
    reconcilePreviewServerSessions(threadRef, {
      sessions: [
        snapshot("tab_7", "2026-01-01T00:00:01.000Z"),
        snapshot("tab_8", "2026-01-01T00:00:02.000Z"),
      ],
      serverEpoch: "server-a",
      revision: 1,
    });
    await using screen = await renderHost();

    const host = screen.container.querySelector("[data-electron-browser-host]")!;
    const webviews = () => [...host.querySelectorAll("webview")];
    const before = webviews();
    expect(before.map((node) => node.getAttribute("data-preview-server-tab")).toSorted()).toEqual([
      "tab_7",
      "tab_8",
    ]);

    // Electron destroys a webview's guest when its element leaves the DOM, so a reorder that
    // detaches and re-inserts the element blanks the tab.
    const detached: Node[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) detached.push(...record.removedNodes);
    });
    observer.observe(host, { childList: true, subtree: true });

    await act(async () => {
      reconcilePreviewServerSessions(threadRef, {
        sessions: [
          snapshot("tab_8", "2026-01-01T00:00:02.000Z"),
          snapshot("tab_7", "2026-01-01T00:00:03.000Z"),
        ],
        serverEpoch: "server-a",
        revision: 2,
      });
    });
    observer.takeRecords().forEach((record) => detached.push(...record.removedNodes));
    observer.disconnect();

    expect(detached).toEqual([]);
    const after = webviews();
    expect(after).toHaveLength(2);
    expect(after.every((node, index) => node.isSameNode(before[index]!))).toBe(true);
  });

  it("keeps a tab an agent drives painting only while its thread has work going, so its actions get frames", async () => {
    using _state = setup();
    mocks.threadRunStatus = "running";
    useBrowserSurfaceStore.setState({ byTabId: {}, activityByTabId: {} });
    const serverTab = (tabId: string, automationOwner?: string): PreviewSessionSnapshot => ({
      ...snapshot(tabId, "2026-01-01T00:00:01.000Z"),
      runtime: "server",
      ...(automationOwner === undefined ? {} : { automationOwner }),
    });
    reconcilePreviewServerSessions(threadRef, {
      sessions: [serverTab("tab_agent", "agent-session"), serverTab("tab_person")],
      serverEpoch: "server-a",
      revision: 1,
    });
    await using _screen = await renderHost();
    const held = () => useBrowserSurfaceStore.getState().activityByTabId;
    const agentTab = previewRuntimeTabId(threadRef, "server-a", "tab_agent");
    const personTab = previewRuntimeTabId(threadRef, "server-a", "tab_person");
    await vi.waitFor(() => expect(held()[agentTab]).toBe(1));
    expect(held()[personTab]).toBeUndefined();
    // The turn ends while subagents it started still work: they may still drive the tab.
    await act(() => {
      mocks.threadRunStatus = "subagents";
      for (const listener of runListeners) listener();
    });
    expect(held()[agentTab]).toBe(1);
    // Nothing left running: a page the agent left open parks like any tab no view shows.
    await act(() => {
      mocks.threadRunStatus = "idle";
      for (const listener of runListeners) listener();
    });
    await vi.waitFor(() => expect(held()[agentTab]).toBeUndefined());
    // The next turn holds it again.
    await act(() => {
      mocks.threadRunStatus = "running";
      for (const listener of runListeners) listener();
    });
    await vi.waitFor(() => expect(held()[agentTab]).toBe(1));
    mocks.threadRunStatus = "idle";
  });
});
