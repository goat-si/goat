import { act, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { EnvironmentId, ThreadId } from "@goat/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";
const state = vi.hoisted(() => ({
  supported: true,
  allowed: true,
  destination: "",
  listeners: new Set<() => void>(),
}));
function subscribe(listener: () => void) {
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
  };
}
vi.mock("../../state/environments", () => ({
  useEnvironment: () => {
    const supported = useSyncExternalStore(subscribe, () => state.supported);
    return {
      serverConfig: {
        environment: { capabilities: supported ? { memory: { protocolVersion: 1 } } : {} },
      },
    };
  },
}));
vi.mock("../../state/session", async (original) => ({
  ...(await original<typeof import("../../state/session")>()),
  useEnvironmentScope: () => useSyncExternalStore(subscribe, () => state.allowed),
  readEnvironmentScope: () => state.allowed,
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => async (input: { to: string; search: Record<string, unknown> }) => {
    const query = new URLSearchParams(
      Object.entries(input.search)
        .filter((entry) => entry[1] !== undefined)
        .map(([key, value]) => [key, String(value)]),
    );
    state.destination = `${input.to}?${query}`;
  },
}));
vi.mock("~/hooks/useThreadActionMenu", () => ({
  useThreadActionMenu: () => ({ openMenu: () => {}, closeMenu: () => {} }),
}));
vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: () => vi.fn(),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../hooks/useSettings", () => ({ useClientSettings: () => undefined }));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../goatBot/GoatBotModeButton", () => ({ GoatBotModeButton: () => null }));
vi.mock("../../notes/ThreadNotesButton", () => ({ ThreadNotesButton: () => null }));
vi.mock("../preview/sessions/AgentScreenCardsToggle", () => ({
  AgentScreenCardsToggle: () => null,
}));
import { ChatHeader } from "./ChatHeader";
let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  state.allowed = true;
  state.supported = true;
  state.destination = "";
  vi.unstubAllGlobals();
});
it("keeps memory management out of the thread header", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  dispose = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  const render = () =>
    root.render(
      <ChatHeader
        activeThreadEnvironmentId={EnvironmentId.make("remote-owner")}
        activeThreadId={ThreadId.make("remote-thread")}
        activeThreadTitle="Synthetic thread"
        isServerThread
        activeProject={null}
        parentThreadLink={null}
        onOpenThread={() => {}}
        rightPanelOpen={false}
        onNewThreadInProject={() => {}}
      />,
    );
  await act(async () => render());
  const button = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === "Memory",
  );
  expect(button).toBeUndefined();
  expect(state.destination).toBe("");
});
