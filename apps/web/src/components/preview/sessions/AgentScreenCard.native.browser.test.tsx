import "~/index.css";

import { type EnvironmentId, type PreviewSession, ThreadId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../../test/render";

const environmentId = "env-native-cards" as EnvironmentId;
const bridge = vi.hoisted(() => ({
  goBack: vi.fn(),
  goForward: vi.fn(),
  refresh: vi.fn(),
  navigate: vi.fn(),
  pictureInPicture: { open: vi.fn(), close: vi.fn() },
}));
vi.mock("../previewBridge", () => ({ previewBridge: bridge }));

// This window is the desktop app hosting the environment, so it draws server tabs natively.
vi.mock(import("~/env"), async (original) => ({ ...(await original()), isElectron: true }));
vi.mock(import("~/state/primaryEnvironment"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  return {
    ...(await original()),
    primaryEnvironmentIdAtom: Atom.make("env-native-cards") as never,
  };
});
vi.mock("../../../state/previewSessions", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    useDesktopSessionFrame: () => ({ event: null, failed: false }),
    previewSessionsEnvironment: { control: { permissionAtom: () => Atom.make(true) } },
  };
});
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
}));
vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useThreadShell: () => null,
  readEnvironmentSupportsServerBrowser: () => true,
  useEnvironmentSupportsServerBrowser: () => true,
}));
vi.mock("../../../browserFaviconStore", () => ({ useFaviconForThreadUrl: () => null }));
// The stream needs a server; this stub marks where the card streams the tab.
vi.mock("../../../browser/ServerBrowserSurface", () => ({
  ServerBrowserSurface: () => <canvas width={4} height={4} data-testid="session-frame" />,
}));

import { applyPreviewServerEvent } from "../../../previewStateStore";
import { AppAtomRegistryProvider } from "../../../rpc/atomRegistry";
import { AgentScreenCard, AgentScreenCardView } from "./AgentScreenCard";

const threadId = ThreadId.make("thread-native");
const tab: PreviewSession = {
  id: "browser:thread-native:tab-1",
  kind: "browser",
  environmentId,
  host: "mac",
  platform: "mac",
  threadId,
  target: { kind: "browser", tabId: "tab-1", url: "http://localhost:8036/", title: "GOAT (Dev)" },
  owner: "agent",
  status: "acting",
  capabilities: {
    controls: ["takeover", "stop"],
    frames: true,
    privateMode: true,
    humanInput: true,
  },
};
const snapshot = {
  threadId,
  tabId: "tab-1",
  navStatus: { _tag: "Success", url: "http://localhost:8036/", title: "GOAT (Dev)" },
  canGoBack: false,
  canGoForward: false,
  runtime: "server",
  automationOwner: "agent-a",
  updatedAt: "2026-01-01T00:00:00.000Z",
} as const;

it("streams a tab with Take over once the server renders it, instead of waiting for a webview", async () => {
  const ref = { environmentId, threadId };
  const event = { threadId, tabId: "tab-1", createdAt: snapshot.updatedAt, serverEpoch: "epoch" };
  await using screen = await render(
    <AppAtomRegistryProvider>
      <AgentScreenCard
        session={tab}
        size="card"
        width={240}
        live
        focused={false}
        focusRequest={0}
        onExpand={() => undefined}
        onControl={() => undefined}
        onDismiss={() => undefined}
      />
    </AppAtomRegistryProvider>,
  );
  act(() => applyPreviewServerEvent(ref, { ...event, type: "opened", revision: 1, snapshot }));
  await expect.element(screen.getByTestId("session-frame")).not.toBeInTheDocument();
  expect(screen.container.querySelector('[aria-label="Take over"]')).toBeNull();

  act(() =>
    applyPreviewServerEvent(ref, {
      ...event,
      type: "resized",
      revision: 2,
      snapshot: { ...snapshot, serverRendered: true },
    }),
  );
  await expect.element(screen.getByTestId("session-frame")).toBeInTheDocument();
  expect(screen.container.querySelector('[aria-label="Take over"]')).not.toBeNull();
});

it("uses the hosted tab for enlarged native navigation and disables controls until hosted", async () => {
  bridge.goBack.mockClear();
  bridge.refresh.mockClear();
  bridge.navigate.mockClear();
  const ref = { environmentId, threadId };
  await act(() =>
    applyPreviewServerEvent(ref, {
      threadId,
      tabId: "tab-1",
      createdAt: snapshot.updatedAt,
      serverEpoch: "native-test",
      type: "opened",
      revision: 1,
      snapshot: { ...snapshot, canGoBack: true },
    }),
  );
  const view = (hosted: { runtimeTabId: string; overlay: null } | null) => (
    <AgentScreenCardView
      session={tab}
      size="large"
      threadTitle="Thread"
      live
      canControl
      canOperateBrowser
      drawnHere
      hosted={hosted}
      focused={false}
      focusRequest={0}
      onExpand={() => undefined}
      onControl={() => undefined}
      onDismiss={() => undefined}
    />
  );
  await using screen = await render(view(null));
  await expect.element(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();
  await screen.rerender(view({ runtimeTabId: "hosted-tab", overlay: null }));
  await userEvent.click(screen.getByRole("button", { name: "Back" }));
  await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
  const address = screen.getByRole("combobox", { name: "Search or enter URL" });
  await userEvent.click(address);
  await userEvent.clear(address);
  await userEvent.type(address, "https://example.com/{Enter}");
  expect(bridge.goBack).toHaveBeenCalledWith("hosted-tab");
  expect(bridge.refresh).toHaveBeenCalledWith("hosted-tab");
  expect(bridge.navigate).toHaveBeenCalledWith("hosted-tab", "https://example.com/");
  await vi.waitFor(() =>
    expect(screen.container.querySelector("[data-browser-surface-slot]")).not.toBeNull(),
  );
});
