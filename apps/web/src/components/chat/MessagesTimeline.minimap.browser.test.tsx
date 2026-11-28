import { expect, it, vi } from "vite-plus/test";
import { cdp, page } from "vite-plus/test/browser";
import "~/index.css";
import { act } from "../../../test/render";
import { MessagesTimeline } from "./MessagesTimeline";
import {
  baseProps,
  click,
  message,
  renderElement,
  renderTimeline,
} from "./MessagesTimeline.browserHarness";

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

it("keeps minimap marks apart in a thread with many user messages", async () => {
  const entries = Array.from({ length: 400 }, (_, index) =>
    message(`Question ${index}`, {}, `user-${index}`),
  );
  await using screen = await renderTimeline(entries);
  const tops = () =>
    [...screen.container.querySelectorAll<HTMLElement>("[data-minimap-strip]")]
      .map((strip) => strip.getBoundingClientRect().top)
      .sort((a, b) => a - b);
  await vi.waitFor(() => expect(tops().length).toBeGreaterThan(1));
  const markTops = tops();
  const gaps = markTops.slice(1).map((top, index) => top - markTops[index]!);
  // A mark is 2px tall; closer than 4px apart and neighbours read as one bar.
  expect(Math.min(...gaps)).toBeGreaterThanOrEqual(4);
});

it("keeps the minimap off the copy button when the chat lane is shifted left", async () => {
  const pageSize = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(1280, 800);
  await using _pageSize = {
    [Symbol.asyncDispose]: () => page.viewport(pageSize.width, pageSize.height),
  };
  const props = baseProps();
  const entries = Array.from({ length: 6 }, (_, index) => [
    message(`Question ${index}`, {}, `user-${index}`),
    message(`Answer ${index}`, { role: "assistant" }, `assistant-${index}`),
  ]).flat();
  // ChatCanvas at 1024px with the details card open: a 48px left gutter, not a centered one.
  await using screen = await renderElement(
    <div
      data-chat-canvas
      style={{ display: "flex", flexDirection: "column", height: 800, width: 1024 }}
      className="[--chat-lane-inset-end:276px]"
    >
      <MessagesTimeline {...props} timelineEntries={entries} />
    </div>,
  );
  const viewport = props.listRef.current!.getScrollableNode()!;
  const lane = screen.container.querySelector<HTMLElement>("[data-timeline-root]")!;
  await vi.waitFor(() => {
    expect(screen.container.querySelector("[data-minimap-strip]")).not.toBeNull();
    const laneRect = lane.getBoundingClientRect();
    const viewportRect = viewport.getBoundingClientRect();
    expect(laneRect.left - viewportRect.left).toBeLessThan(viewportRect.right - laneRect.right);
  });

  const jump = screen.buttons(/^Jump to message/)[0]!;
  await vi.waitFor(() =>
    expect(jump.getBoundingClientRect().right).toBeLessThanOrEqual(
      lane.getBoundingClientRect().left,
    ),
  );
});

it("moves the minimap off the chat lane when the lane shifts left without resizing", async () => {
  const pageSize = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(1600, 800);
  await using _pageSize = {
    [Symbol.asyncDispose]: () => page.viewport(pageSize.width, pageSize.height),
  };
  const props = baseProps();
  const entries = Array.from({ length: 6 }, (_, index) => [
    message(`Question ${index}`, {}, `user-${index}`),
    message(`Answer ${index}`, { role: "assistant" }, `assistant-${index}`),
  ]).flat();
  await using screen = await renderElement(
    <div
      data-chat-canvas
      style={{ display: "flex", flexDirection: "column", height: 800, width: 1600 }}
    >
      <MessagesTimeline {...props} timelineEntries={entries} />
    </div>,
  );
  const canvas = screen.container.querySelector<HTMLElement>("[data-chat-canvas]")!;
  const lane = screen.container.querySelector<HTMLElement>("[data-timeline-root]")!;
  await vi.waitFor(() =>
    expect(screen.container.querySelector("[data-minimap-strip]")).not.toBeNull(),
  );
  const laneWidth = lane.getBoundingClientRect().width;

  // Opening the details card on a wide canvas moves the lane left at full width.
  canvas.style.setProperty("--chat-lane-inset-end", "740px");
  const jump = screen.buttons(/^Jump to message/)[0]!;
  await vi.waitFor(() => {
    expect(lane.getBoundingClientRect().width).toBe(laneWidth);
    expect(jump.getBoundingClientRect().right).toBeLessThanOrEqual(
      lane.getBoundingClientRect().left,
    );
  });
});
