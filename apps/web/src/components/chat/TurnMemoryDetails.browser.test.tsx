import { EnvironmentId, RunId, ThreadId, type TurnMemoryResult } from "@goat/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { TurnMemoryDetails } from "./TurnMemoryDetails";

const inspect = vi.fn(() => receipt);
const receipt = Atom.make(Option.some<TurnMemoryResult>({ events: [], truncated: false }));
const allowed = Atom.make(true);
vi.mock("../../state/memory", () => ({
  memoryEnvironment: {
    canInspectTurnMemory: () => allowed,
    turnMemoryForRun: () => inspect(),
  },
}));
vi.mock("gt-react", () => ({ useGT: () => (message: string) => message }));

it("keeps historical turns without receipts distinguishable from an empty recall", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <TurnMemoryDetails
          environmentId={EnvironmentId.make("env")}
          threadId={ThreadId.make("thread")}
          runId={RunId.make("run")}
        />,
      ),
    );
    expect(inspect).not.toHaveBeenCalled();
    const button = container.querySelector("button")!;
    await act(async () => button.click());
    expect(container.textContent).toContain("No memory activity was recorded for this turn.");
    expect(container.textContent).not.toContain("No visible entries.");
    await act(async () => button.click());
    expect(container.textContent).toBe("Turn memory");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
