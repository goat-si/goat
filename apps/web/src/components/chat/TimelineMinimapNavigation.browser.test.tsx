import { describe, expect, it, vi } from "vite-plus/test";
import "~/index.css";
import { MessagesTimeline } from "./MessagesTimeline";
import {
  baseProps,
  message,
  renderElement,
  renderTimeline,
} from "./MessagesTimeline.browserHarness";
import { rememberTimelinePosition } from "./timelineScrollAnchoring";

describe("timeline minimap navigation", () => {
  it("disables the minimap's next turn button at the bottom of the thread", async () => {
    const props = baseProps();
    const entries = Array.from({ length: 16 }, (_, index) => [
      message(`Question ${index}`, {}, `user-${index}`),
      message(`Answer ${index}`, { role: "assistant" }, `assistant-${index}`),
    ]).flat();
    await using screen = await renderTimeline(entries, props);
    const viewport = props.listRef.current!.getScrollableNode()!;
    const strips = () => [
      ...screen.container.querySelectorAll<HTMLElement>("[data-minimap-strip]"),
    ];
    // Several final turns share the last screen, so the current turn is not the last one.
    await vi.waitFor(() => {
      expect(viewport.scrollTop).toBeGreaterThan(0);
      expect(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop).toBeLessThan(2);
      expect(strips()[0]?.dataset.inView).toBe("false");
      expect(
        strips()
          .slice(-2)
          .map((strip) => strip.dataset.inView),
      ).toEqual(["true", "true"]);
      expect(screen.button("Previous turn")).not.toBeDisabled();
    });

    expect(screen.button("Next turn")).toBeDisabled();

    viewport.scrollTop -= 30;
    await vi.waitFor(() => expect(screen.button("Next turn")).not.toBeDisabled());
    // Legend re-pins a viewport at its end on resize, so a shrink cannot move the end away.
    // Growing a detached viewport until the thread fits reaches the end without a scroll event.
    await screen.rerender(
      <MessagesTimeline {...props} timelineEntries={entries} liveFollowEnabled={false} />,
    );
    viewport.scrollTop = 0;
    await vi.waitFor(() => {
      expect(strips()[0]?.dataset.inView).toBe("true");
      expect(screen.button("Next turn")).not.toBeDisabled();
    });
    screen.container.style.height = "8000px";
    await vi.waitFor(() => {
      expect(viewport.scrollHeight).toBeLessThanOrEqual(viewport.clientHeight);
      expect(screen.button("Next turn")).toBeDisabled();
    });
    screen.container.style.height = "1200px";

    // So does a footer that grows below a detached bottom.
    viewport.scrollTop = viewport.scrollHeight;
    await vi.waitFor(() => expect(screen.button("Next turn")).toBeDisabled());
    await screen.rerender(
      <MessagesTimeline
        {...props}
        timelineEntries={entries}
        liveFollowEnabled={false}
        footer={<div style={{ height: 400 }} />}
      />,
    );
    await vi.waitFor(() => {
      expect(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop).toBeGreaterThan(
        300,
      );
      expect(screen.button("Next turn")).not.toBeDisabled();
    });
  });

  it("enables the minimap's next turn button on a thread restored above its bottom", async () => {
    const base = baseProps();
    const turns = (prefix: string) =>
      Array.from({ length: 16 }, (_, index) => [
        message(`${prefix} question ${index}`, {}, `${prefix}-user-${index}`),
        message(`${prefix} answer ${index}`, { role: "assistant" }, `${prefix}-assistant-${index}`),
      ]).flat();
    const other = "environment-local:thread-minimap-restored";
    rememberTimelinePosition(
      other,
      { rowId: "entry-b-user-4", offsetWithinRow: 0, scrollOffset: 0, atEnd: false },
      false,
    );
    await using screen = await renderElement(
      <MessagesTimeline {...base} timelineEntries={turns("a")} />,
    );
    const viewport = base.listRef.current!.getScrollableNode()!;
    await vi.waitFor(() => {
      expect(viewport.scrollTop).toBeGreaterThan(0);
      expect(screen.button("Next turn")).toBeDisabled();
    });

    await screen.rerender(
      <MessagesTimeline
        {...base}
        routeThreadKey={other}
        timelineEntries={turns("b")}
        liveFollowEnabled={false}
      />,
    );
    await vi.waitFor(() => {
      const row = screen.container.querySelector('[data-timeline-row-id="entry-b-user-4"]');
      expect(row).not.toBeNull();
      expect(
        Math.abs(row!.getBoundingClientRect().top - viewport.getBoundingClientRect().top),
      ).toBeLessThanOrEqual(2);
      expect(screen.button("Next turn")).not.toBeDisabled();
    });
  });
});
