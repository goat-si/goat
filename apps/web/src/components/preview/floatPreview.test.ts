import { scopedThreadKey, scopeThreadRef } from "@goat/client-runtime/environment";
import { type EnvironmentId, type PreviewSessionSnapshot, ThreadId } from "@goat/contracts";
import { expect, it } from "vite-plus/test";

import { browserMiniPlayerSource, usePreviewMiniPlayerStore } from "../../previewMiniPlayerStore";
import { applyPreviewServerSnapshot, resetPreviewStateForTests } from "../../previewStateStore";
import { useRightPanelStore } from "../../rightPanelStore";
import { floatPreview } from "./floatPreview";
import {
  openPreviewSessionStack,
  selectAgentCardsShown,
  usePreviewSessionStack,
} from "./sessions/previewSessionStackStore";

const ref = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-1"));
const threadKey = scopedThreadKey(ref);
const phone = {
  kind: "device",
  hostId: "host-1",
  deviceId: "device-1",
  platform: "ios",
  name: "Phone",
} as const;
const tab = (tabId: string, automationOwner?: string): PreviewSessionSnapshot => ({
  threadId: "thread-1",
  tabId,
  navStatus: { _tag: "Loading", url: "http://localhost:5173/", title: "" },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-01-01T00:00:00.000Z",
  runtime: "server",
  ...(automationOwner === undefined ? {} : { automationOwner }),
});

function setup() {
  resetPreviewStateForTests();
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
  useRightPanelStore.setState({ byThreadKey: {} });
  usePreviewSessionStack.setState({
    hidden: true,
    expanded: new Map(),
    revealedThreads: new Set(),
    focus: null,
  });
}

const floating = () => usePreviewMiniPlayerStore.getState().byThreadKey[threadKey]?.source;
const agentTab = (threadId: string, tabId: string) => ({
  id: `browser:${threadId}:${tabId}`,
  kind: "browser" as const,
  environmentId: "env-1" as EnvironmentId,
  host: "mac",
  platform: "mac" as const,
  threadId: ThreadId.make(threadId),
  target: { kind: "browser" as const, tabId, url: "http://localhost:5173/", title: "" },
  owner: "agent" as const,
  status: "acting" as const,
  capabilities: { controls: ["stop" as const], frames: true, privateMode: true, humanInput: true },
});
const deviceTabs = () =>
  useRightPanelStore
    .getState()
    .byThreadKey[threadKey]?.surfaces.filter((surface) => surface.kind === "device")
    .map((surface) => surface.id);

it("floats a person's own tab, and shows a tab an agent drives as its small card even when a person asks", () => {
  setup();
  applyPreviewServerSnapshot(ref, tab("tab_own"));
  applyPreviewServerSnapshot(ref, tab("tab_agent", "agent-session"));
  floatPreview(ref, browserMiniPlayerSource("tab_own"), { by: "person" });
  expect(floating()).toEqual({ kind: "browser", tabId: "tab_own" });

  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
  floatPreview(ref, browserMiniPlayerSource("tab_agent"), { by: "person" });
  expect(floating()).toBeUndefined();
  expect(usePreviewSessionStack.getState().hidden).toBe(false);
  expect(usePreviewSessionStack.getState().focus).toEqual({
    kind: "browser",
    threadId: "thread-1",
    tabId: "tab_agent",
  });
  expect(usePreviewSessionStack.getState().expanded.size).toBe(0);

  floatPreview(ref, browserMiniPlayerSource("tab_agent"), { by: "agent", force: true });
  expect(usePreviewSessionStack.getState().expanded.size).toBe(0);
});

it("keeps a card the person enlarged large when its agent shows the tab again", () => {
  setup();
  applyPreviewServerSnapshot(ref, tab("tab_agent", "agent-session"));
  usePreviewSessionStack.getState().expand(agentTab("thread-1", "tab_agent"));
  floatPreview(ref, browserMiniPlayerSource("tab_agent"), { by: "agent", force: true });
  expect(usePreviewSessionStack.getState().expanded.get("env-1|thread-1")).toMatchObject({
    sessionId: "browser:thread-1:tab_agent",
  });
});

it("leaves the thread on screen's large card and hidden cards alone when another thread's agent opens a tab", () => {
  setup();
  const other = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-2"));
  applyPreviewServerSnapshot(ref, tab("tab_mine", "agent-session"));
  applyPreviewServerSnapshot(other, {
    ...tab("tab_theirs", "agent-session"),
    threadId: "thread-2",
  });
  usePreviewSessionStack.getState().expand(agentTab("thread-1", "tab_mine"));
  floatPreview(other, browserMiniPlayerSource("tab_theirs"), { by: "agent", force: true });
  const state = usePreviewSessionStack.getState();
  expect(state.expanded.get("env-1|thread-1")).toMatchObject({
    sessionId: "browser:thread-1:tab_mine",
  });
  expect(state.expanded.has("env-1|thread-2")).toBe(false);
  expect(selectAgentCardsShown("env-1|thread-1")(state)).toBe(false);
  expect(selectAgentCardsShown("env-1|thread-2")(state)).toBe(true);

  // Closing an enlarged card shrinks only that thread's card.
  usePreviewSessionStack.getState().expand(agentTab("thread-2", "tab_theirs"));
  usePreviewSessionStack.getState().dismiss(agentTab("thread-2", "tab_theirs"));
  const after = usePreviewSessionStack.getState().expanded;
  expect(after.has("env-1|thread-2")).toBe(false);
  expect(after.get("env-1|thread-1")).toMatchObject({ sessionId: "browser:thread-1:tab_mine" });
});

it("ends an agent's reveal of its thread's cards when the person hides them or the pane narrows", () => {
  setup();
  usePreviewSessionStack.setState({ hidden: false, narrow: false });
  const shown = () => selectAgentCardsShown("env-1|thread-1")(usePreviewSessionStack.getState());
  const reveal = () =>
    openPreviewSessionStack({
      environmentId: ref.environmentId,
      focus: { kind: "browser", threadId: "thread-1", tabId: "tab_mine" },
      scope: "thread",
    });
  usePreviewSessionStack
    .getState()
    .setShown(false, scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-2")));
  expect(shown()).toBe(false);
  reveal();
  expect(shown()).toBe(true);
  // Hiding from another thread is the window's choice and hides this thread's cards too.
  usePreviewSessionStack
    .getState()
    .setShown(false, scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-2")));
  expect(shown()).toBe(false);

  reveal();
  expect(shown()).toBe(true);
  usePreviewSessionStack.getState().setNarrow(true);
  expect(shown()).toBe(false);
});

it("opens a device an agent started as a background panel tab, and floats one a person asks for", () => {
  setup();
  floatPreview(ref, phone, { by: "agent" });
  expect(floating()).toBeUndefined();
  expect(deviceTabs()).toEqual(["device:host-1:device-1"]);
  floatPreview(ref, phone, { by: "agent" });
  expect(deviceTabs()).toEqual(["device:host-1:device-1"]);

  floatPreview(ref, phone, { by: "person" });
  expect(floating()).toEqual(phone);
});
