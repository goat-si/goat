import "~/index.css";

import { type EnvironmentId, type PreviewSession, ThreadId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../../test/render";

const environmentId = "env-native-cards" as EnvironmentId;

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
import { AgentScreenCard } from "./AgentScreenCard";

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
