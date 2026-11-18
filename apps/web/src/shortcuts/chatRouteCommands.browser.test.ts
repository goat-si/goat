import { AuthPreviewOperateScope, EnvironmentId } from "@goat/contracts";
import type { AnyRouter } from "@tanstack/react-router";
import { describe, expect, it, vi } from "vite-plus/test";

import { readPreviewFindAvailable } from "../components/preview/findAvailability";
import { subscribePreviewAction } from "../components/preview/previewActionBus";
import { readEnvironmentScope } from "../state/session";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { installChatRouteCommands } from "./chatRouteCommands";
import { registerCommands } from "./dispatcher";

vi.mock("../components/preview/findAvailability", { spy: true });
vi.mock(import("../state/server"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const { compileResolvedKeybindingsConfig } = await import("@goat/shared/keybindings");
  return {
    ...(await original()),
    primaryServerKeybindingsAtom: Atom.make(
      compileResolvedKeybindingsConfig([{ key: "f", command: "preview.find" }]),
    ),
  };
});

type Match = {
  readonly routeId: string;
  readonly pathname: string;
  readonly params?: Record<string, string>;
};

function routerAt(matches: Match[]) {
  const withParams = (match: Match) => ({ ...match, params: match.params ?? {} });
  const state = { matches: matches.map(withParams) };
  return {
    router: { state } as unknown as AnyRouter,
    navigate: (next: Match[]) => {
      state.matches = next.map(withParams);
    },
  };
}

const CHAT: Match[] = [
  { routeId: "__root__", pathname: "/" },
  { routeId: "/_chat", pathname: "/" },
];

function pressKey(key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, cancelable: true, bubbles: true });
  window.dispatchEvent(event);
  return event;
}

const pressEscape = () => pressKey("Escape");

function selectThread(threadKey: string) {
  useThreadSelectionStore.getState().clearSelection();
  useThreadSelectionStore.getState().toggleThread(threadKey);
}

describe("chat route commands", () => {
  it("lets a lower shortcut scope handle Find when the preview cannot search", () => {
    const { router } = routerAt(CHAT);
    const lower = vi.fn();
    using stack = new DisposableStack();
    stack.defer(registerCommands({ "preview.find": lower }));
    stack.defer(installChatRouteCommands(router));

    expect(pressKey("f").defaultPrevented).toBe(false);
    expect(lower).toHaveBeenCalledOnce();
  });

  it("dispatches Find for a searchable preview without browser operate permission", () => {
    const environmentId = EnvironmentId.make("read-only-env");
    const { router } = routerAt([
      ...CHAT,
      {
        routeId: "/_chat/$environmentId/$threadId",
        pathname: "/read-only-env/thread-1",
        params: { environmentId, threadId: "thread-1" },
      },
    ]);
    const onPreviewAction = vi.fn();
    const available = vi.mocked(readPreviewFindAvailable).mockReturnValue(true);
    using stack = new DisposableStack();
    stack.defer(() => available.mockRestore());
    stack.defer(subscribePreviewAction(onPreviewAction));
    stack.defer(installChatRouteCommands(router));

    expect(readEnvironmentScope(environmentId, AuthPreviewOperateScope)).toBe(false);
    expect(pressKey("f").defaultPrevented).toBe(true);
    expect(onPreviewAction).toHaveBeenCalledExactlyOnceWith("find");
  });

  it("clears a selection made after install, reading the store at keypress time", () => {
    const { router } = routerAt(CHAT);
    using stack = new DisposableStack();
    stack.defer(installChatRouteCommands(router));
    stack.defer(() => useThreadSelectionStore.getState().clearSelection());

    selectThread("env:thread-1");
    const event = pressEscape();

    expect(event.defaultPrevented).toBe(true);
    expect(useThreadSelectionStore.getState().selectedThreadKeys.size).toBe(0);
    // With nothing selected, Escape is left for other handlers.
    expect(pressEscape().defaultPrevented).toBe(false);
  });

  it("stays out of the way off the chat route and under modal pages", () => {
    const { router, navigate } = routerAt([{ routeId: "__root__", pathname: "/pair" }]);
    using stack = new DisposableStack();
    stack.defer(installChatRouteCommands(router));
    stack.defer(() => useThreadSelectionStore.getState().clearSelection());
    selectThread("env:thread-1");

    expect(pressEscape().defaultPrevented).toBe(false);

    navigate([...CHAT, { routeId: "/_chat/settings", pathname: "/settings" }]);
    expect(pressEscape().defaultPrevented).toBe(false);
    expect(useThreadSelectionStore.getState().selectedThreadKeys.size).toBe(1);

    navigate([
      ...CHAT,
      { routeId: "/_chat/settings/appearance", pathname: "/settings/appearance" },
    ]);
    expect(pressEscape().defaultPrevented).toBe(false);
    navigate([...CHAT, { routeId: "/_chat/usage", pathname: "/usage" }]);
    expect(pressEscape().defaultPrevented).toBe(false);
    expect(useThreadSelectionStore.getState().selectedThreadKeys.size).toBe(1);

    navigate(CHAT);
    expect(pressEscape().defaultPrevented).toBe(true);
  });
});
