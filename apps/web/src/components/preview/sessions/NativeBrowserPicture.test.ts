import {
  EnvironmentId,
  type PreviewListResult,
  type PreviewSession,
  type PreviewSessionSnapshot,
  ThreadId,
} from "@goat/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  listAtom: null as Atom.Atom<AsyncResult.AsyncResult<PreviewListResult>> | null,
  eventsAtom: null as Atom.Atom<AsyncResult.AsyncResult<never>> | null,
}));

vi.mock("~/env", () => ({ isElectron: true }));
vi.mock("~/state/preview", () => ({
  previewEnvironment: {
    list: () => state.listAtom!,
    events: () => state.eventsAtom!,
  },
}));

import { rendersServerTabNatively } from "~/browser/previewRuntime";
import { readThreadPreviewState, resetPreviewStateForTests } from "~/previewStateStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { desktopCardPreviewSyncAtom } from "../usePreviewSession";
import { cardServerTabSnapshot, useHostedTab } from "./NativeBrowserPicture";

const environmentId = EnvironmentId.make("env-1");
const threadId = ThreadId.make("thread-1");
const threadRef = { environmentId, threadId };

vi.mock("~/previewStateStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/previewStateStore")>();
  return {
    ...actual,
    useThreadPreviewState: (ref: typeof threadRef | null) =>
      ref ? actual.readThreadPreviewState(ref) : actual.readThreadPreviewState(threadRef),
  };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: Atom.Atom<unknown>) => appAtomRegistry.get(atom),
}));

const session: PreviewSession = {
  id: "browser:thread-1:tab-1",
  kind: "browser",
  environmentId,
  host: "mac",
  platform: "mac",
  threadId,
  target: { kind: "browser", tabId: "tab-1", url: "https://search.naver.com/", title: "Naver" },
  owner: "agent",
  status: "acting",
  capabilities: {
    controls: ["takeover", "stop"],
    frames: true,
    privateMode: true,
    humanInput: true,
  },
};

const snapshot = (serverRendered?: true): PreviewSessionSnapshot => ({
  threadId: "thread-1",
  tabId: "tab-1",
  runtime: "server",
  navStatus: { _tag: "Success", url: "https://search.naver.com/", title: "Naver" },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-10-29T00:00:00.000Z",
  ...(serverRendered ? { serverRendered: true } : {}),
});

describe("isolated and desktop-hosted browser tab cards", () => {
  it("loads an unloaded background thread's preview list and streams an isolated server-rendered tab", () => {
    resetPreviewStateForTests();
    const listAtom = Atom.make<AsyncResult.AsyncResult<PreviewListResult>>(AsyncResult.initial());
    state.listAtom = listAtom;
    state.eventsAtom = Atom.make(AsyncResult.initial());

    // Mount the real sync atom through useHostedTab while preview.list is still waiting.
    const unmount = appAtomRegistry.mount(desktopCardPreviewSyncAtom(threadRef));
    try {
      expect(useHostedTab(session)).toBeNull();
      // While unloaded, the card defaults to SERVER_TAB so a shared-profile tab does not flash a stream.
      expect(
        rendersServerTabNatively(
          environmentId,
          environmentId,
          cardServerTabSnapshot(session, readThreadPreviewState(threadRef).sessions),
        ),
      ).toBe(true);

      // When preview.list resolves with an isolated (serverRendered: true) tab, the sync atom
      // reconciles it into previewStateStore: drawnHere becomes false and useHostedTab stays null.
      appAtomRegistry.set(
        listAtom,
        AsyncResult.success({
          sessions: [snapshot(true)],
          serverEpoch: "epoch-1",
          revision: 1,
        }),
      );
      expect(useHostedTab(session)).toBeNull();
      expect(
        rendersServerTabNatively(
          environmentId,
          environmentId,
          cardServerTabSnapshot(session, readThreadPreviewState(threadRef).sessions),
        ),
      ).toBe(false);

      // A shared-profile server tab on this desktop is hosted in a webview.
      appAtomRegistry.set(
        listAtom,
        AsyncResult.success({
          sessions: [snapshot()],
          serverEpoch: "epoch-1",
          revision: 2,
        }),
      );
      expect(useHostedTab(session)).toEqual({
        runtimeTabId: JSON.stringify([environmentId, "thread-1", "epoch-1", "tab-1"]),
        overlay: null,
      });
      expect(
        rendersServerTabNatively(
          environmentId,
          environmentId,
          cardServerTabSnapshot(session, readThreadPreviewState(threadRef).sessions),
        ),
      ).toBe(true);
    } finally {
      unmount();
    }
  });
});
