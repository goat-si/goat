import { EnvironmentId, RunId, ThreadId, type TurnMemoryResult } from "@goat/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { render } from "../../../test/render";
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
  await using screen = await render(
    <TurnMemoryDetails
      environmentId={EnvironmentId.make("env")}
      threadId={ThreadId.make("thread")}
      runId={RunId.make("run")}
    />,
    { router: false },
  );
  expect(inspect).not.toHaveBeenCalled();
  const button = screen.getByRole("button", { name: "Turn memory" });
  await button.click();
  expect(screen.container.textContent).toContain("No memory activity was recorded for this turn.");
  expect(screen.container.textContent).not.toContain("No visible entries.");
  await button.click();
  expect(screen.container.textContent).toBe("Turn memory");
});
