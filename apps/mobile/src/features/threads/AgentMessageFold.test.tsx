import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ThreadId } from "@goat/contracts";
import { AtomRegistry } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  open: vi.fn(),
  live: new Set<string>(),
}));
vi.mock("../../state/session", async () => {
  const Option = await import("effect/Option");
  return {
    usePreparedConnection: (environmentId: string | null) =>
      environmentId !== null && harness.live.has(environmentId) ? Option.some({}) : Option.none(),
  };
});
vi.mock("../../state/entities", () => ({ useQuietThreadShell: () => null }));
vi.mock("./useOpenLinkedThread", () => ({ useOpenLinkedThread: () => harness.open }));
vi.mock("./thread-work-log", () => ({ ThreadDisclosureChevron: () => null }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("expo-haptics", () => ({ selectionAsync: async () => {} }));
vi.mock("react-native", () => ({
  Pressable: ({
    children,
    accessibilityLabel,
    onPress,
  }: {
    children: ReactNode;
    accessibilityLabel?: string;
    onPress: () => void;
  }) => (
    <button aria-label={accessibilityLabel} onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({
    children,
    accessibilityHint,
  }: {
    children: ReactNode;
    accessibilityHint?: string;
  }) => <span data-hint={accessibilityHint}>{children}</span>,
}));
import { AgentMessageSentByLabel, OpenSenderThreadButton } from "./AgentMessageFold";

const here = EnvironmentId.make("env-here");
const remoteSender = {
  environmentId: EnvironmentId.make("env-studio"),
  environmentLabel: "mac-studio",
  threadId: ThreadId.make("coordinator"),
  title: "Coordinator",
};

function mount(node: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const registry = AtomRegistry.make();
  act(() => root.render(<RegistryContext value={registry}>{node}</RegistryContext>));
  return {
    container,
    [Symbol.dispose]: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}
const both = (
  <>
    <AgentMessageSentByLabel environmentId={here} remoteSender={remoteSender} />
    <OpenSenderThreadButton environmentId={here} remoteSender={remoteSender} />
  </>
);

describe("a message sent from another machine", () => {
  it("names its sender and opens it on that machine while it is connected", () => {
    harness.open.mockClear();
    harness.live = new Set(["env-studio"]);
    using view = mount(both);
    expect(view.container.textContent).toContain("Sent by Coordinator from another thread");
    act(() =>
      view.container.querySelector<HTMLButtonElement>('[aria-label="Open Coordinator"]')!.click(),
    );
    expect(harness.open).toHaveBeenCalledWith({
      environmentId: "env-studio",
      threadId: "coordinator",
    });
    expect(view.container.textContent).toContain("Open thread");
  });

  it("stays plain and says how to open it while that machine is disconnected", () => {
    harness.live = new Set();
    using view = mount(both);
    expect(view.container.textContent).toContain("Sent by Coordinator from another thread");
    expect(view.container.querySelectorAll("button")).toHaveLength(0);
    expect(view.container.querySelector("span")?.dataset.hint).toBe(
      "Connect mac-studio to open this thread.",
    );
  });
});
