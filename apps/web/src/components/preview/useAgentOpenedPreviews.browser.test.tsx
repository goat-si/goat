import "~/index.css";

import {
  type DeviceServiceState,
  EnvironmentId,
  type PreviewSessionSnapshot,
  PreviewTabId,
  ThreadId,
} from "@goat/contracts";
import { Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import {
  selectThreadPreviewMiniPlayer,
  usePreviewMiniPlayerStore,
} from "../../previewMiniPlayerStore";
import type { ThreadPreviewState } from "../../previewStateStore";
import { usePreviewSessionStack } from "./sessions/previewSessionStackStore";
import { useAgentOpenedPreviews } from "./useAgentOpenedPreviews";

const desktopEnvironment = EnvironmentId.make("env-desktop");
const remoteEnvironment = EnvironmentId.make("env-remote");

// The desktop app, whose own server is the primary environment.
vi.mock(import("~/env"), async (original) => ({ ...(await original()), isElectron: true }));
vi.mock("../../state/primaryEnvironment", () => ({
  primaryEnvironmentIdAtom: Atom.make("env-desktop"),
}));

const noDevices = { sessions: [], devices: [], hosts: [] } as unknown as DeviceServiceState;

const previewState = (
  sessions: Record<string, PreviewSessionSnapshot> = {},
): ThreadPreviewState => ({
  snapshot: null,
  sessions,
  suppressedTabIds: new Set(),
  activeTabId: null,
  desktopOverlay: null,
  desktopByTabId: {},
  recentlySeenUrls: [],
  listLoaded: true,
  serverEpoch: "epoch-1",
  serverRevision: 1,
});

const agentTab: PreviewSessionSnapshot = {
  threadId: "thread-agent",
  tabId: PreviewTabId.make("tab_1"),
  navStatus: { _tag: "Success", url: "https://ko.wikipedia.org/", title: "Wikipedia" },
  canGoBack: false,
  canGoForward: false,
  runtime: "server",
  automationOwner: "agent-session",
  reveal: true,
  revealRequest: { id: "reveal-1", force: true },
  updatedAt: "2026-10-25T00:00:00.000Z",
};

function Agent(props: {
  readonly environmentId: EnvironmentId;
  readonly previewState: ThreadPreviewState;
}) {
  useAgentOpenedPreviews({
    threadRef: { environmentId: props.environmentId, threadId: ThreadId.make("thread-agent") },
    deviceState: noDevices,
    deviceStateLoaded: false,
    previewState: props.previewState,
    serverBrowserAvailable: true,
    panelSurfaces: [],
    miniPlayerSource: null,
    sheetLayout: false,
  });
  return null;
}

function setup() {
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
  usePreviewSessionStack.setState({ expanded: null, focus: null });
}

const opened = (environmentId: EnvironmentId) => ({
  floating: selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, {
    environmentId,
    threadId: ThreadId.make("thread-agent"),
  })?.source,
  card: usePreviewSessionStack.getState().expanded,
});

it("an agent tab this desktop draws opens as the large card, which shows its webview", async () => {
  setup();
  await using screen = await render(
    <Agent environmentId={desktopEnvironment} previewState={previewState()} />,
    { router: false }, // The hook reads no route.
  );
  await screen.rerender(
    <Agent environmentId={desktopEnvironment} previewState={previewState({ tab_1: agentTab })} />,
  );
  expect(opened(desktopEnvironment)).toMatchObject({
    floating: undefined,
    card: { kind: "browser", tabId: "tab_1", environmentId: desktopEnvironment },
  });
});

it("an agent tab another environment's server draws still opens as the large card", async () => {
  setup();
  await using screen = await render(
    <Agent environmentId={remoteEnvironment} previewState={previewState()} />,
    { router: false }, // The hook reads no route.
  );
  await screen.rerender(
    <Agent environmentId={remoteEnvironment} previewState={previewState({ tab_1: agentTab })} />,
  );
  expect(opened(remoteEnvironment)).toMatchObject({
    floating: undefined,
    card: { kind: "browser", tabId: "tab_1", environmentId: remoteEnvironment },
  });
});
