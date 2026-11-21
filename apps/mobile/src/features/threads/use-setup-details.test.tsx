import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vite-plus/test";
import { useSetupDetails } from "./use-setup-details";

function Harness({ thread, handoff }: { thread: string; handoff: boolean }) {
  const details = useSetupDetails(thread);
  return (
    <div>
      <button onClick={details.open}>{handoff ? "chip" : "card"}</button>
      {details.isOpen ? <div role="dialog">setup details</div> : null}
    </div>
  );
}

it("keeps the setup sheet open across handoff, but not across threads", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Harness thread="one" handoff={false} />));
    await act(async () => container.querySelector("button")?.click());
    await act(async () => root.render(<Harness thread="one" handoff />));
    expect(container.querySelector('[role="dialog"]')?.textContent).toBe("setup details");
    await act(async () => root.render(<Harness thread="two" handoff />));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => root.render(<Harness thread="one" handoff />));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});
