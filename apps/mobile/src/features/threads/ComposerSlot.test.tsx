import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

import { useSettledComposerHeight } from "./ComposerSlot";

// The hook only measures; the slot components it sits beside are not rendered here.
vi.mock("react-native", () => ({ View: () => null }));

type Settled = ReturnType<typeof useSettledComposerHeight>;

async function renderSettledHeight() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const latest: { current: Settled | null } = { current: null };
  function Probe() {
    const settled = useSettledComposerHeight();
    useLayoutEffect(() => {
      latest.current = settled;
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe />));
  const current = () => {
    if (latest.current === null) throw new Error("probe did not render");
    return latest.current;
  };
  return { current, [Symbol.asyncDispose]: () => act(async () => root.unmount()) };
}

describe("useSettledComposerHeight", () => {
  it("keeps the room for a pending card independent of that card's own height", async () => {
    await using probe = await renderSettledHeight();
    vi.useFakeTimers();
    try {
      const settle = async (report: (settled: Settled) => void) => {
        await act(async () => report(probe.current()));
        await act(async () => vi.advanceTimersByTime(220));
      };
      await settle((settled) => {
        settled.onSlotHeight(100);
        settled.onCardsHeight(40);
        settled.onPendingHeight(300);
      });
      expect(probe.current().height).toBe(440);
      expect(probe.current().heightBesidePending).toBe(140);

      // A capped card that shrinks must not hand itself more room, or it grows back and loops.
      await settle((settled) => settled.onPendingHeight(180));
      expect(probe.current().height).toBe(320);
      expect(probe.current().heightBesidePending).toBe(140);
    } finally {
      vi.useRealTimers();
    }
  });
});
