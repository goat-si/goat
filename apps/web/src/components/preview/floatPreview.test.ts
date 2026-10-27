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
const deviceTabs = () =>
  useRightPanelStore
    .getState()
    .byThreadKey[threadKey]?.surfaces.filter((surface) => surface.kind === "device")
    .map((surface) => surface.id);

it("floats a person's own tab, and sends a tab an agent drives to its large card even when a person asks", () => {
  setup();
  applyPreviewServerSnapshot(ref, tab("tab_own"));
  applyPreviewServerSnapshot(ref, tab("tab_agent", "agent-session"));
  floatPreview(ref, browserMiniPlayerSource("tab_own"), { by: "person" });
  expect(floating()).toEqual({ kind: "browser", tabId: "tab_own" });

  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
  floatPreview(ref, browserMiniPlayerSource("tab_agent"), { by: "person" });
  expect(floating()).toBeUndefined();
  expect(usePreviewSessionStack.getState().hidden).toBe(false);
  expect(usePreviewSessionStack.getState().expanded.get("env-1|thread-1")).toEqual({
    kind: "browser",
    threadId: "thread-1",
    tabId: "tab_agent",
    environmentId: "env-1",
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
  openPreviewSessionStack({
    environmentId: ref.environmentId,
    focus: { kind: "browser", threadId: "thread-1", tabId: "tab_mine" },
    expand: true,
    automatic: true,
  });
  floatPreview(other, browserMiniPlayerSource("tab_theirs"), { by: "agent", force: true });
  const state = usePreviewSessionStack.getState();
  expect(state.expanded.get("env-1|thread-1")).toMatchObject({ tabId: "tab_mine" });
  expect(state.expanded.get("env-1|thread-2")).toMatchObject({ tabId: "tab_theirs" });
  expect(selectAgentCardsShown("env-1|thread-1")(state)).toBe(false);
  expect(selectAgentCardsShown("env-1|thread-2")(state)).toBe(true);

  // Closing the card an agent enlarged shrinks only that thread's card.
  usePreviewSessionStack.getState().dismiss({
    id: "browser:thread-2:tab_theirs",
    kind: "browser",
    environmentId: "env-1" as EnvironmentId,
    host: "mac",
    platform: "mac",
    threadId: ThreadId.make("thread-2"),
    target: { kind: "browser", tabId: "tab_theirs", url: "http://localhost:5173/", title: "" },
    owner: "agent",
    status: "acting",
    capabilities: { controls: ["stop"], frames: true, privateMode: true, humanInput: true },
  });
  const after = usePreviewSessionStack.getState().expanded;
  expect(after.has("env-1|thread-2")).toBe(false);
  expect(after.get("env-1|thread-1")).toMatchObject({ tabId: "tab_mine" });
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
