import type { AnyRouter } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { stubGlobal } from "../../test/render";
import { TestNotification, thread, toV2ThreadShell } from "./threadNotificationTestShell";

const state = vi.hoisted(() => ({
  mode: "sound",
  unlock: vi.fn(),
  sound: vi.fn(),
  badge: vi.fn(),
}));

vi.mock(import("../state/shell"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentShell: {
      ...actual.environmentShell,
      stateValueAtom: ((id: string) => shellAtom(id)) as never,
    },
  };
});
vi.mock(import("../state/presentation"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentSummaries: {
      ...actual.environmentSummaries,
      get environmentIdsAtom() {
        return environmentIdsAtom as never;
      },
    },
  };
});
vi.mock(import("../hooks/useSettings"), async (original) => ({
  ...(await original()),
  subscribeClientSettings: (() => () => {}) as never,
  getClientSettings: (() => ({
    notificationMode: state.mode,
    inAppNotificationsEnabled: false,
  })) as never,
}));
vi.mock(import("../threadNotifications"), async (original) => ({
  ...(await original()),
  playNotificationSound: state.sound,
  unlockNotificationAudio: state.unlock,
  setNotificationBadge: state.badge,
}));

import { startThreadNotifications } from "./ThreadNotificationCoordinator";

const shellAtom = Atom.family((_id: string) => Atom.make<unknown>(null));
const environmentIdsAtom = Atom.make<ReadonlyArray<string>>([]);

it.each([
  { client: "desktop app", when: "at startup", bridge: {}, beforeGesture: 1 },
  { client: "browser", when: "on the first gesture", bridge: undefined, beforeGesture: 0 },
])("readies notification sound in the $client $when", async ({ bridge, beforeGesture }) => {
  vi.clearAllMocks();
  const stack = new AsyncDisposableStack();
  const registry = AtomRegistry.make();
  stack.defer(() => registry.dispose());
  registry.set(environmentIdsAtom, ["one"]);
  registry.set(shellAtom("one"), {
    status: "live",
    snapshot: Option.some({ threads: [toV2ThreadShell(thread)] }),
  });
  stack.use(stubGlobal("Notification", TestNotification));
  stack.use(stubGlobal("desktopBridge", bridge));
  const router = {
    state: { matches: [{ params: {} }], location: { pathname: "/", search: {} } },
    navigate: vi.fn(),
    subscribe: () => () => {},
  } as unknown as AnyRouter;
  try {
    stack.defer(startThreadNotifications(registry, router));
    expect(state.unlock).toHaveBeenCalledTimes(beforeGesture);
    document.dispatchEvent(new Event("pointerdown"));
    expect(state.unlock).toHaveBeenCalledTimes(beforeGesture + 1);
  } finally {
    await stack.disposeAsync();
  }
});
