import { scopedThreadKey, scopeThreadRef } from "@goat/client-runtime/environment";
import { type EnvironmentId, type PreviewSessionSnapshot, ThreadId } from "@goat/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { browserMiniPlayerSource, usePreviewMiniPlayerStore } from "../../previewMiniPlayerStore";
import {
  __testing as previewStateTesting,
  applyPreviewServerEvent,
  applyPreviewServerSnapshot,
  beginPreviewSessionClose,
  cancelPreviewSessionClose,
  reconcilePreviewServerSessions,
  resetPreviewStateForTests,
} from "../../previewStateStore";
import { useRightPanelStore } from "../../rightPanelStore";
import {
  followPreviewSessions,
  revealServerTabs,
  startAgentOpenedPreviews,
} from "./agentOpenedPreviews";
import { selectAgentCardsShown, usePreviewSessionStack } from "./sessions/previewSessionStackStore";

vi.mock("../../state/entities", () => ({
  readEnvironmentSupportsServerBrowser: () => true,
}));

const ref = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-1"));
const threadKey = scopedThreadKey(ref);

function setup() {
  resetPreviewStateForTests();
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
  useRightPanelStore.setState({ byThreadKey: {} });
  usePreviewSessionStack.setState({
    hidden: true,
    expanded: new Map(),
    revealedThreads: new Set(),
    focus: null,
    hiddenLive: new Map(),
  });
}

const miniPlayerSource = () => usePreviewMiniPlayerStore.getState().byThreadKey[threadKey]?.source;
const largeCard = (thread = "thread-1") =>
  usePreviewSessionStack.getState().expanded.get(`env-1|${thread}`) ?? null;
const focusedTab = () => usePreviewSessionStack.getState().focus?.tabId ?? null;
const shownIn = (thread: string) =>
  selectAgentCardsShown(`env-1|${thread}`)(usePreviewSessionStack.getState());

describe("revealServerTabs", () => {
  const tab = (tabId: string, force?: boolean): PreviewSessionSnapshot => ({
    threadId: "thread-1",
    tabId,
    navStatus: { _tag: "Loading", url: "http://localhost:5173/", title: "" },
    canGoBack: false,
    canGoForward: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
    runtime: "server",
    reveal: true,
    ...(force === undefined ? {} : { revealRequest: { id: "r1", force } }),
  });
  const floatingTabId = () => {
    const source = miniPlayerSource();
    return source?.kind === "browser" ? source.tabId : null;
  };

  it("floats revealed tabs, and only forced ones when floating previews are off", () => {
    setup();
    revealServerTabs(ref, [tab("tab_plain")], { autoShowFloatingPreview: false });
    expect(floatingTabId()).toBeNull();
    revealServerTabs(ref, [tab("tab_forced", true)], { autoShowFloatingPreview: false });
    expect(floatingTabId()).toBe("tab_forced");
  });

  it("focuses a tab already in the panel instead of floating it when forced", () => {
    setup();
    useRightPanelStore.getState().openBrowser(ref, "tab_a");
    const browserSurfaceId = useRightPanelStore.getState().byThreadKey[threadKey]?.activeSurfaceId;
    useRightPanelStore.getState().open(ref, "diff");

    revealServerTabs(ref, [tab("tab_a", false)], { autoShowFloatingPreview: true });
    expect(useRightPanelStore.getState().byThreadKey[threadKey]?.activeSurfaceId).not.toBe(
      browserSurfaceId,
    );
    revealServerTabs(ref, [tab("tab_a", true)], { autoShowFloatingPreview: true });
    expect(useRightPanelStore.getState().byThreadKey[threadKey]?.activeSurfaceId).toBe(
      browserSurfaceId,
    );
    expect(floatingTabId()).toBeNull();
  });

  // Browser use starts like computer use: as the thread's small card, never the mini player.
  it("opens an agent's tab as its thread's small card, only forced ones when floating is off", () => {
    setup();
    const agentTab = (tabId: string, force?: boolean) => ({
      ...tab(tabId, force),
      automationOwner: "agent-session",
    });
    applyPreviewServerSnapshot(ref, agentTab("tab_quiet"));
    revealServerTabs(ref, [agentTab("tab_quiet")], { autoShowFloatingPreview: false });
    expect(focusedTab()).toBeNull();

    applyPreviewServerSnapshot(ref, agentTab("tab_agent"));
    revealServerTabs(ref, [agentTab("tab_agent")], { autoShowFloatingPreview: true });
    expect(floatingTabId()).toBeNull();
    expect(focusedTab()).toBe("tab_agent");
    expect(largeCard()).toBeNull();
    // On its own it leaves the window's hidden cards alone; a forced reveal shows them, but only
    // in its own thread.
    expect(shownIn("thread-1")).toBe(false);
    applyPreviewServerSnapshot(ref, agentTab("tab_forced", true));
    revealServerTabs(ref, [agentTab("tab_forced", true)], { autoShowFloatingPreview: false });
    expect(floatingTabId()).toBeNull();
    expect(focusedTab()).toBe("tab_forced");
    expect(largeCard()).toBeNull();
    expect(shownIn("thread-1")).toBe(true);
    expect(shownIn("thread-2")).toBe(false);
  });
});

describe("followPreviewSessions", () => {
  const snapshot = (tabId: string, reveal = true): PreviewSessionSnapshot => ({
    threadId: "thread-1",
    tabId,
    navStatus: { _tag: "Loading", url: "http://localhost:5173/", title: "" },
    canGoBack: false,
    canGoForward: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
    runtime: "server",
    reveal,
  });
  const previewState = (sessions: ReadonlyArray<PreviewSessionSnapshot>, listLoaded = true) => ({
    ...previewStateTesting.EMPTY_THREAD_PREVIEW_STATE,
    listLoaded,
    sessions: Object.fromEntries(sessions.map((entry) => [entry.tabId, entry])),
  });
  const browserTabs = () =>
    useRightPanelStore
      .getState()
      .byThreadKey[threadKey]?.surfaces.filter((surface) => surface.kind === "preview")
      .map((surface) => surface.id);

  it("adds visible sessions as tabs and drops tabs whose session ended", () => {
    setup();
    useRightPanelStore.getState().openBrowser(ref, "tab_gone");
    followPreviewSessions(ref, previewState([snapshot("tab_a"), snapshot("tab_hidden", false)]));
    expect(browserTabs()).toEqual(["browser:tab_a"]);
  });

  it("waits for the first server list before treating missing sessions as closed", () => {
    setup();
    useRightPanelStore.getState().openBrowser(ref, "tab_a");
    usePreviewMiniPlayerStore.getState().open(ref, browserMiniPlayerSource("tab_a"));
    followPreviewSessions(ref, previewState([], false));
    expect(browserTabs()).toEqual(["browser:tab_a"]);
    expect(miniPlayerSource()).toMatchObject({ kind: "browser", tabId: "tab_a" });

    followPreviewSessions(ref, previewState([]));
    expect(browserTabs()).toEqual([]);
    expect(miniPlayerSource()).toBeUndefined();
  });
});

describe("startAgentOpenedPreviews", () => {
  const serverEpoch = "server-a";
  const serverTab = (overrides: Partial<PreviewSessionSnapshot> = {}): PreviewSessionSnapshot => ({
    threadId: "thread-1",
    tabId: "tab_a",
    navStatus: { _tag: "Loading", url: "http://localhost:5173/", title: "" },
    canGoBack: false,
    canGoForward: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
    runtime: "server",
    reveal: true,
    ...overrides,
  });
  const following = () => {
    setup();
    return { [Symbol.dispose]: startAgentOpenedPreviews() };
  };
  const navigated = (revision: number, snapshot: PreviewSessionSnapshot) =>
    applyPreviewServerEvent(ref, {
      type: "navigated",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: snapshot.updatedAt,
      snapshot,
      serverEpoch,
      revision,
    });
  const floatingTabId = () => {
    const source = miniPlayerSource();
    return source?.kind === "browser" ? source.tabId : null;
  };
  const browserTabs = (threadKeyToRead = threadKey) =>
    useRightPanelStore
      .getState()
      .byThreadKey[threadKeyToRead]?.surfaces.filter((surface) => surface.kind === "preview")
      .map((surface) => surface.id);

  it("treats the first list as a baseline and floats tabs opened later", () => {
    using _following = following();
    reconcilePreviewServerSessions(ref, {
      sessions: [serverTab({ tabId: "tab_restored" })],
      serverEpoch,
      revision: 1,
    });
    expect(floatingTabId()).toBeNull();
    expect(browserTabs()).toEqual(["browser:tab_restored"]);

    const opened = serverTab({ tabId: "tab_agent" });
    applyPreviewServerEvent(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: opened.tabId,
      createdAt: opened.updatedAt,
      snapshot: opened,
      serverEpoch,
      revision: 2,
    });
    expect(floatingTabId()).toBe("tab_agent");
  });

  it("starts an agent's new tab in any thread as that thread's small card, with no mini player", () => {
    using _following = following();
    const other = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-2"));
    reconcilePreviewServerSessions(other, { sessions: [], serverEpoch, revision: 1 });
    const opened = serverTab({ threadId: "thread-2", tabId: "tab_b", automationOwner: "agent" });
    applyPreviewServerEvent(other, {
      type: "opened",
      threadId: "thread-2",
      tabId: opened.tabId,
      createdAt: opened.updatedAt,
      snapshot: opened,
      serverEpoch,
      revision: 2,
    });
    expect(usePreviewMiniPlayerStore.getState().byThreadKey).toEqual({});
    expect(usePreviewSessionStack.getState().focus).toEqual({
      kind: "browser",
      threadId: "thread-2",
      tabId: "tab_b",
    });
    expect(largeCard("thread-2")).toBeNull();
  });

  it("reveals an existing tab only for a new reveal request", () => {
    using _following = following();
    const tab = serverTab({ revealRequest: { id: "r1", force: false } });
    reconcilePreviewServerSessions(ref, { sessions: [tab], serverEpoch, revision: 1 });

    navigated(2, { ...tab, updatedAt: "2026-01-01T00:00:01.000Z" });
    expect(floatingTabId()).toBeNull();

    navigated(3, {
      ...tab,
      revealRequest: { id: "r2", force: true },
      updatedAt: "2026-01-01T00:00:02.000Z",
    });
    expect(useRightPanelStore.getState().byThreadKey[threadKey]?.activeSurfaceId).toBe(
      "browser:tab_a",
    );
  });

  it("never reveals tabs this client opened, desktop tabs, or a tab whose close failed", () => {
    using _following = following();
    const tab = serverTab({ tabId: "tab_closing" });
    reconcilePreviewServerSessions(ref, { sessions: [tab], serverEpoch, revision: 1 });
    applyPreviewServerSnapshot(ref, serverTab({ tabId: "tab_own", reveal: undefined }));
    applyPreviewServerSnapshot(ref, { ...serverTab({ tabId: "tab_desktop" }), runtime: "desktop" });
    beginPreviewSessionClose(ref, tab.tabId);
    cancelPreviewSessionClose(ref, tab, tab.tabId);
    expect(floatingTabId()).toBeNull();
  });

  it("follows background threads and closes the floating browser when its session ends", () => {
    using _following = following();
    const other = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-2"));
    reconcilePreviewServerSessions(other, {
      sessions: [serverTab({ threadId: "thread-2", tabId: "tab_b" })],
      serverEpoch,
      revision: 1,
    });
    expect(browserTabs(scopedThreadKey(other))).toEqual(["browser:tab_b"]);

    reconcilePreviewServerSessions(ref, { sessions: [], serverEpoch, revision: 1 });
    const opened = serverTab();
    applyPreviewServerEvent(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: opened.tabId,
      createdAt: opened.updatedAt,
      snapshot: opened,
      serverEpoch,
      revision: 2,
    });
    expect(floatingTabId()).toBe("tab_a");
    applyPreviewServerEvent(ref, {
      type: "closed",
      threadId: "thread-1",
      tabId: opened.tabId,
      createdAt: opened.updatedAt,
      serverEpoch,
      revision: 3,
    });
    expect(floatingTabId()).toBeNull();
  });
});
