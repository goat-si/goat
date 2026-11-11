import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";

// The thread route loads ChatView lazily; its first transform would eat the test's timeout.
import "~/components/ChatView";
import { useRightPanelStore } from "~/rightPanelStore";
import type { FakeDriver } from "../../test/fakeEnvironment";
import { act } from "../../test/render";
import { mountTwoThreads, press } from "./Sidebar.shortcuts.testkit";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

vi.mock(import("~/state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const { compileResolvedKeybindingsConfig } = await import("@goat/shared/keybindings");
  const keybindings = compileResolvedKeybindingsConfig([
    { key: "mod+shift+]", command: "thread.next", when: "!previewFocus && !previewOpen" },
    { key: "mod+1", command: "thread.jump.1", when: "!previewFocus" },
  ]);
  return { ...actual, primaryServerKeybindingsAtom: Atom.make(keybindings) };
});

// Its own file: the app keeps each environment's server config for the whole file.
it("treats a remembered preview tab as closed where no browser can show it, as the chat does", async () => {
  const { stack, router, firstRef, secondPath } = await mountTwoThreads(false);
  await using _app = stack;
  await act(() => useRightPanelStore.getState().openBrowser(firstRef, null));
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  await press();
  await vi.waitFor(() => expect(router.history.location.pathname).toBe(secondPath));
});
