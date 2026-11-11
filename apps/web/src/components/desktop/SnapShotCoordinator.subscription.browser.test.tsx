import type { DesktopSnapShotEvent } from "@goat/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@goat/contracts/settings";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { toastManager } from "../ui/toast";
import { SnapShotCoordinator } from "./SnapShotCoordinator";

const settings = { ...DEFAULT_CLIENT_SETTINGS, snapShotEnabled: true };
vi.mock("../../hooks/useSettings", () => ({
  getClientSettings: () => settings,
  useClientSettings: <T,>(select: (value: typeof settings) => T) => select(settings),
}));
// The remembered project's machine is still loading, so no fallback project is ready yet.
vi.mock("../../hooks/useHandleNewThread", () => ({
  LAST_USED_PROJECT_STORAGE_KEY: "goat:last-used-project:v1",
  lastUsedProjectKeySchema: Schema.NullOr(Schema.String),
  useHandleNewThread: () => ({
    activeDraftThread: null,
    activeThread: null,
    defaultProjectRef: null,
    defaultProjectFallbackReady: false,
    handleNewThread: vi.fn(),
    routeDraftId: null,
    routeThreadRef: null,
  }),
}));

it("reports a failed capture while the last used project is still connecting", async () => {
  const listener: { current: ((event: DesktopSnapShotEvent) => void) | null } = { current: null };
  const bridge = {
    requestSnapShotPermissions: vi.fn(),
    getSnapShotState: vi.fn(async () => ({ message: "Screen recording is off." })),
    checkSnapShotShortcut: vi.fn(),
    setSnapShotShortcutSuppressed: vi.fn(),
    listPendingSnapShots: vi.fn(async () => []),
    readSnapShot: vi.fn(),
    acknowledgeSnapShot: vi.fn(),
    onSnapShotEvent: (handler: (event: DesktopSnapShotEvent) => void) => {
      listener.current = handler;
      return () => {
        listener.current = null;
      };
    },
  };
  using _bridge = installBridge(bridge);
  using add = vi.spyOn(toastManager, "add");
  await using _screen = await render(<SnapShotCoordinator />);
  await vi.waitFor(() => expect(listener.current).not.toBeNull());
  listener.current?.({ type: "failed", id: "capture-1" } as DesktopSnapShotEvent);
  await vi.waitFor(() =>
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ title: "Snapshot failed" })),
  );
});

function installBridge(bridge: object) {
  const previous = window.desktopBridge;
  window.desktopBridge = bridge as NonNullable<typeof window.desktopBridge>;
  return {
    [Symbol.dispose]: () => {
      if (previous) window.desktopBridge = previous;
      else delete window.desktopBridge;
    },
  };
}
