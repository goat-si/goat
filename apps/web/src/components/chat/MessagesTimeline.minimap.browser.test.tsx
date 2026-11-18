import { expect, it, vi } from "vite-plus/test";
import { cdp } from "vite-plus/test/browser";
import "~/index.css";
import { act } from "../../../test/render";
import { baseProps, click, message, renderTimeline } from "./MessagesTimeline.browserHarness";

it("steps the minimap's next turn past two adjacent user messages", async () => {
  const props = baseProps();
  const reply = (id: string) => message("Reply.\n\n".repeat(120), { role: "assistant" }, id);
  const userIds = ["turn-0", "turn-1", "turn-2", "pair-a", "pair-b", "turn-3", "turn-4"];
  const entries = [
    ...["turn-0", "turn-1", "turn-2"].flatMap((id) => [message(id, {}, id), reply(`${id}-r`)]),
    message("pair-a", {}, "pair-a"),
    message("pair-b", {}, "pair-b"),
    reply("pair-b-r"),
    ...["turn-3", "turn-4"].flatMap((id) => [message(id, {}, id), reply(`${id}-r`)]),
  ];
  const session = cdp();
  await session.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  try {
    await using screen = await renderTimeline(entries, props);
    const viewport = props.listRef.current!.getScrollableNode()!;
    const strips = () => [...screen.container.querySelectorAll("[data-minimap-strip]")];
    const turnAtTop = () =>
      userIds.find((id) => {
        const row = screen.container.querySelector(`[data-message-id="${id}"]`);
        if (!row) return false;
        const offset = row.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
        return offset >= 0 && offset < 100;
      });
    await act(() => {
      void props.listRef.current!.scrollToIndex({ index: 0, animated: false });
    });
    await vi.waitFor(() => expect(strips()[0]?.getAttribute("data-in-view")).toBe("true"));

    // Clicks again while the view has not moved, as a user would.
    for (const id of userIds.slice(1)) {
      const from = turnAtTop();
      await vi.waitFor(async () => {
        if (turnAtTop() === from) await click(screen.button("Next turn"));
        expect(turnAtTop(), "turn at the top after Next turn").toBe(id);
      });
    }
  } finally {
    await session.send("Emulation.setEmulatedMedia", { features: [] });
  }
});
