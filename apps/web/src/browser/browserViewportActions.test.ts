import { describe, expect, it, vi } from "vite-plus/test";

import {
  type AuthSessionState,
  EnvironmentId,
  type PreviewResizeInput,
  type PreviewViewportSetting,
  ThreadId,
  type PreviewSessionSnapshot,
} from "@goat/contracts";

const boundary = vi.hoisted(() => ({
  resize: vi.fn<(input: PreviewResizeInput) => Promise<PreviewSessionSnapshot>>(),
  destinations: [] as EnvironmentId[],
}));

vi.mock("@goat/client-runtime/state/session", async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const session: AuthSessionState = {
    authenticated: true,
    scopes: ["preview:operate"],
    permissions: ["preview:operate"],
    auth: {
      policy: "remote-reachable",
      bootstrapMethods: [],
      sessionMethods: [],
      sessionCookieName: "synthetic",
    },
  };
  const sessionStateAtom = Atom.family((_id: EnvironmentId) =>
    Atom.make(AsyncResult.success(session)),
  );
  return { createEnvironmentSessionAtoms: () => ({ sessionStateAtom }) };
});
vi.mock("~/state/preview", async () => {
  const { WS_METHODS } = await import("@goat/contracts");
  const { EnvironmentRegistry } = await import("@goat/client-runtime/connection");
  const { createEnvironmentRpcCommand } = await import("@goat/client-runtime/state/runtime");
  const Effect = await import("effect/Effect");
  const Layer = await import("effect/Layer");
  const { Atom } = await import("effect/reactivity");
  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, {
      run: (environmentId, effect) => {
        boundary.destinations.push(environmentId);
        return effect;
      },
    } as EnvironmentRegistry.EnvironmentRegistry["Service"]),
  );
  return {
    previewEnvironment: {
      // Keep the RPC fixture parallel so it cannot mask a missing viewport commit queue.
      resize: createEnvironmentRpcCommand(runtime, {
        label: "test:preview:resize",
        tag: WS_METHODS.previewResize,
        execute: (input) => Effect.promise(() => boundary.resize(input)),
      }),
    },
  };
});
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));

import {
  applyPreviewServerSnapshot,
  readThreadPreviewState,
  resetPreviewStateForTests,
} from "~/previewStateStore";
import { commitBrowserViewportChange } from "./browserViewportActions";

const threadRef = {
  environmentId: EnvironmentId.make("env-remote"),
  threadId: ThreadId.make("thread-1"),
};
const target = { threadRef, tabId: "tab-background", runtimeTabId: "runtime-background" };
const initialViewport: PreviewViewportSetting = { _tag: "freeform", width: 1280, height: 720 };

function snapshot(
  tabId: string,
  viewport: PreviewViewportSetting = initialViewport,
): PreviewSessionSnapshot {
  return {
    threadId: threadRef.threadId,
    tabId,
    navStatus: { _tag: "Success", url: `https://example.test/${tabId}`, title: tabId },
    viewport,
    canGoBack: false,
    canGoForward: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function setup(): Disposable {
  resetPreviewStateForTests();
  boundary.resize.mockReset();
  boundary.destinations.length = 0;
  applyPreviewServerSnapshot(threadRef, snapshot(target.tabId));
  applyPreviewServerSnapshot(threadRef, snapshot("tab-active"));
  return { [Symbol.dispose]: resetPreviewStateForTests };
}

describe("browserViewportActions", () => {
  it("commits two resizes to the same background tab in order through the environment", async () => {
    using _state = setup();
    const firstGate = Promise.withResolvers<void>();
    const firstStarted = Promise.withResolvers<void>();
    const completed: PreviewViewportSetting[] = [];
    const firstViewport: PreviewViewportSetting = { _tag: "freeform", width: 800, height: 600 };
    const secondViewport: PreviewViewportSetting = { _tag: "freeform", width: 900, height: 700 };
    boundary.resize.mockImplementation(async (input) => {
      expect(input.threadId).toBe(threadRef.threadId);
      if (input.viewport._tag !== "fill" && input.viewport.width === 800) {
        firstStarted.resolve();
        await firstGate.promise;
      }
      completed.push(input.viewport);
      return snapshot(input.tabId, input.viewport);
    });

    const first = commitBrowserViewportChange(target, firstViewport);
    const second = commitBrowserViewportChange(target, secondViewport);
    try {
      await firstStarted.promise;
      expect(readThreadPreviewState(threadRef).sessions[target.tabId]?.viewport).toEqual(
        initialViewport,
      );
      expect(completed).toEqual([]);
    } finally {
      firstGate.resolve();
      await Promise.all([first, second]);
    }

    expect(completed).toEqual([firstViewport, secondViewport]);
    expect(readThreadPreviewState(threadRef).sessions[target.tabId]?.viewport).toEqual(
      secondViewport,
    );
    expect(readThreadPreviewState(threadRef).activeTabId).toBe("tab-active");
    expect(boundary.destinations).toEqual([threadRef.environmentId, threadRef.environmentId]);
  });

  it("resizes a remote tab without a mounted panel and retains the active tab", async () => {
    using _state = setup();
    boundary.resize.mockImplementation(async (input) => {
      expect(input.threadId).toBe(threadRef.threadId);
      return snapshot(input.tabId, input.viewport);
    });
    const before = readThreadPreviewState(threadRef);
    const viewport: PreviewViewportSetting = { _tag: "freeform", width: 390, height: 844 };

    await commitBrowserViewportChange(target, viewport);

    const after = readThreadPreviewState(threadRef);
    expect(after.sessions[target.tabId]?.viewport).toEqual(viewport);
    expect(after.activeTabId).toBe("tab-active");
    expect(after.snapshot).toBe(before.snapshot);
    expect(after.sessions["tab-active"]).toBe(before.sessions["tab-active"]);
    expect(boundary.destinations).toEqual([threadRef.environmentId]);
  });
});
