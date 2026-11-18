import { threadQueueCanPromoteToSteer } from "@goat/client-runtime/state/thread-workflows";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { resolveComposerSendPresentation } from "./composerSendPresentation";
import { SendActionButton } from "./SendActionButton";

vi.mock("../../components/ComposerToolbar", () => ({
  ComposerActionButton: ({
    accessibilityLabel,
    onPress,
  }: {
    accessibilityLabel: string;
    onPress: () => void;
  }) => <button onClick={onPress}>{accessibilityLabel}</button>,
}));

vi.mock("../../components/ui/Menu", () => ({
  Menu: ({
    actions,
    children,
    onPressAction,
  }: {
    actions: ReadonlyArray<{ id: string; title: string }>;
    children: ReactNode;
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
  }) => (
    <>
      {children}
      {actions.map(({ id, title }) => (
        <button
          key={id}
          role="menuitem"
          onClick={() => onPressAction({ nativeEvent: { event: id } })}
        >
          {title}
        </button>
      ))}
    </>
  ),
}));

it.each([true, undefined] as const)(
  "offers a mobile setup Steer only when the server advertises it (%s)",
  async (setupSteering) => {
    await using cleanup = new AsyncDisposableStack();
    const globals = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const prior = globals.IS_REACT_ACT_ENVIRONMENT;
    globals.IS_REACT_ACT_ENVIRONMENT = true;
    cleanup.defer(() => {
      if (prior === undefined) delete globals.IS_REACT_ACT_ENVIRONMENT;
      else globals.IS_REACT_ACT_ENVIRONMENT = prior;
    });
    const container = document.createElement("div");
    const root = createRoot(container);
    cleanup.defer(() => act(async () => root.unmount()));
    const send = vi.fn();
    const presentation = resolveComposerSendPresentation({
      editingQueuedMessage: false,
      running: true,
      canSteer: threadQueueCanPromoteToSteer(
        { activeRun: { status: "preparing" }, canPromoteToSteer: true },
        setupSteering,
      ),
      followUpBehavior: "queue",
      deliveryDeferred: true,
    });
    await act(async () => {
      root.render(
        <SendActionButton
          accessibilityLabel={presentation.label}
          presentation={presentation}
          disabled={false}
          onSend={send}
        />,
      );
    });
    const steer = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ).find((button) => button.textContent === "Steer now");
    if (setupSteering) {
      if (steer === undefined) throw new Error("Expected Steer in the follow-up menu");
      await act(async () => steer.click());
      expect(send).toHaveBeenCalledExactlyOnceWith("steer");
    } else {
      expect(steer).toBeUndefined();
      const queue = container.querySelector("button");
      expect(queue?.textContent).toBe("Queue");
      await act(async () => queue?.click());
      expect(send).toHaveBeenCalledExactlyOnceWith();
    }
  },
);
