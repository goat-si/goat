import { scopedThreadKey, scopeThreadRef } from "@goat/client-runtime/environment";
import { type EnvironmentId, type PreviewSessionSnapshot, ThreadId } from "@goat/contracts";
import { expect, it } from "vite-plus/test";

import { browserMiniPlayerSource, usePreviewMiniPlayerStore } from "../../previewMiniPlayerStore";
import { applyPreviewServerSnapshot, resetPreviewStateForTests } from "../../previewStateStore";
import { useRightPanelStore } from "../../rightPanelStore";
import { floatPreview } from "./floatPreview";
import { usePreviewSessionStack } from "./sessions/previewSessionStackStore";

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
  usePreviewSessionStack.setState({ hidden: true, expanded: null, focus: null });
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
  expect(usePreviewSessionStack.getState()).toMatchObject({
    hidden: false,
    expanded: { kind: "browser", threadId: "thread-1", tabId: "tab_agent", environmentId: "env-1" },
  });
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
