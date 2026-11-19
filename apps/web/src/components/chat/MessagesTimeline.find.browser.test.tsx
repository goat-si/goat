import { describe, expect, it, vi } from "vite-plus/test";
import "~/index.css";
import { MessagesTimeline } from "./MessagesTimeline";
import {
  baseProps,
  message,
  renderElement,
  type TimelineProps,
} from "./MessagesTimeline.browserHarness";
import type { TimelineNavigation } from "./timelineViewport";
import { rememberTimelinePosition } from "./timelineScrollAnchoring";

describe("MessagesTimeline thread find", () => {
  // Opening find is navigation; on a list already showing the thread the open
  // action navigates, so the list itself releases follow only when it starts
  // showing a thread whose find is already open.
  function renderObserved() {
    const navigations: TimelineNavigation[] = [];
    const base = baseProps();
    const element = (next: Partial<TimelineProps>) => (
      <MessagesTimeline
        {...base}
        timelineEntries={[message("Where is the sidebar fix?")]}
        onViewportAttach={(viewport) =>
          viewport.subscribe((navigation) => navigations.push(navigation))
        }
        {...next}
      />
    );
    return { navigations, element };
  }
  const released = { source: "command", releasesFollow: true };

  it("reveals the previous match in a table without scrolling a sibling table", async () => {
    const columns = Array.from({ length: 12 }, (_, index) => `DiagnosticsColumn${index}`);
    const cells = ["needle", ...columns.slice(1, -1), "needle"];
    const table = [columns, columns.map(() => "---"), cells]
      .map((row) => `| ${row.join(" | ")} |`)
      .join("\n");
    const entry = message(`${table}\n\n${table}`);
    const props = {
      ...baseProps(),
      timelineEntries: [entry],
      liveFollowEnabled: false,
      findOpen: true,
      findExpanded: true,
      findQuery: "needle",
    };
    const element = (occurrence: number, navigationId: number) => (
      <MessagesTimeline
        {...props}
        activeFindMatch={{ entryId: entry.id, runId: null, occurrence }}
        findNavigationId={navigationId}
      />
    );
    await using screen = await renderElement(element(1, 1));
    const [viewport, sibling] = await vi.waitFor(() => {
      const tables = screen.container.querySelectorAll<HTMLElement>(
        '.chat-markdown-table-container [data-slot="scroll-area-viewport"]',
      );
      expect(tables).toHaveLength(2);
      return [tables[0]!, tables[1]!] as const;
    });
    viewport.scrollLeft = viewport.scrollWidth;
    sibling.scrollLeft = sibling.scrollWidth;
    const siblingOffset = sibling.scrollLeft;
    const clip = viewport.getBoundingClientRect();
    expect(viewport.querySelector("td")!.getBoundingClientRect().right).toBeLessThan(clip.left);
    expect(siblingOffset).toBeGreaterThan(0);

    await screen.rerender(element(0, 2));
    await vi.waitFor(() => {
      const [match] = CSS.highlights.get("goat-thread-find-active") ?? [];
      if (!(match instanceof Range)) throw new Error("Missing active match range");
      expect(match.startContainer.parentElement?.closest("td")).toBe(viewport.querySelector("td"));
      expect(match.getBoundingClientRect().left).toBeGreaterThanOrEqual(clip.left - 1);
    });
    expect(sibling.scrollLeft).toBe(siblingOffset);
  });

  it("reveals a match in a nested table clipped by the outer table", async () => {
    const columns = Array.from({ length: 12 }, (_, index) => `<td>DiagnosticsColumn${index}</td>`);
    const entry = message(
      `<table><tbody><tr>${columns.join("")}<td><table><tbody><tr><td>needle</td></tr></tbody></table></td></tr></tbody></table>`,
      { role: "assistant" },
    );
    const props = {
      ...baseProps(),
      timelineEntries: [entry],
      liveFollowEnabled: false,
      findOpen: true,
      findExpanded: true,
      findQuery: "needle",
    };
    await using screen = await renderElement(<MessagesTimeline {...props} />);
    const outerViewport = await vi.waitFor(() => {
      const viewport = screen.container.querySelector(
        '.chat-markdown-table-container [data-slot="scroll-area-viewport"]',
      );
      const nestedCell = viewport?.querySelector("table table td");
      expect(nestedCell?.textContent).toBe("needle");
      expect(nestedCell!.getBoundingClientRect().left).toBeGreaterThan(
        viewport!.getBoundingClientRect().right,
      );
      return viewport!;
    });

    await screen.rerender(
      <MessagesTimeline
        {...props}
        activeFindMatch={{ entryId: entry.id, runId: null, occurrence: 0 }}
        findNavigationId={1}
      />,
    );
    await vi.waitFor(() => {
      const [match] = CSS.highlights.get("goat-thread-find-active") ?? [];
      if (!(match instanceof Range)) throw new Error("Missing active match range");
      const bounds = match.getBoundingClientRect();
      const clip = outerViewport.getBoundingClientRect();
      expect(bounds.left).toBeGreaterThanOrEqual(clip.left - 1);
      expect(bounds.right).toBeLessThanOrEqual(clip.right + 1);
    });
  });

  it("releases follow once when it starts showing a thread whose find is open", async () => {
    const { navigations, element } = renderObserved();
    await using screen = await renderElement(element({}));
    expect(navigations).toEqual([]);

    const other = "environment-local:thread-find-open";
    await screen.rerender(element({ routeThreadKey: other, findOpen: true }));
    expect(navigations).toEqual([released]);
    await screen.rerender(element({ routeThreadKey: other, findOpen: false }));
    await screen.rerender(element({ routeThreadKey: other, findOpen: true }));
    expect(navigations).toEqual([released]);
  });

  it("releases follow once when it mounts on a thread whose find is open", async () => {
    const { navigations, element } = renderObserved();
    await using screen = await renderElement(element({ findOpen: true }));
    await screen.rerender(element({ findOpen: true }));
    expect(navigations).toEqual([released]);
  });

  it("still restores the position of a thread it switches to whose find is open", async () => {
    const base = baseProps();
    const other = "environment-local:thread-find-open-positioned";
    const replies = Array.from({ length: 40 }, (_, index) =>
      message(`Reply ${index}\n\n${"line\n\n".repeat(8)}`, { role: "assistant" }, `r-${index}`),
    );
    rememberTimelinePosition(
      other,
      { rowId: "entry-r-20", offsetWithinRow: 0, scrollOffset: 0, atEnd: false },
      false,
    );
    await using screen = await renderElement(
      <MessagesTimeline {...base} timelineEntries={[message("Short thread")]} />,
    );
    await screen.rerender(
      <MessagesTimeline
        {...base}
        routeThreadKey={other}
        timelineEntries={replies}
        liveFollowEnabled={false}
        findOpen
      />,
    );
    const viewport = base.listRef.current!.getScrollableNode()!;
    await vi.waitFor(() => {
      const row = screen.container.querySelector('[data-timeline-row-id="entry-r-20"]');
      expect(row).not.toBeNull();
      expect(
        Math.abs(row!.getBoundingClientRect().top - viewport.getBoundingClientRect().top),
      ).toBeLessThanOrEqual(2);
    });
  });
  it("reveals find's match, not the remembered row, on a thread it switches to", async () => {
    const base = baseProps();
    const other = "environment-local:thread-find-open-match";
    const replies = Array.from({ length: 40 }, (_, index) =>
      message(
        `${index === 5 ? "Needle here" : `Reply ${index}`}\n\n${"line\n\n".repeat(8)}`,
        { role: "assistant" },
        `r-${index}`,
      ),
    );
    rememberTimelinePosition(
      other,
      { rowId: "entry-r-20", offsetWithinRow: 0, scrollOffset: 0, atEnd: false },
      false,
    );
    await using screen = await renderElement(
      <MessagesTimeline {...base} timelineEntries={[message("Short thread")]} />,
    );
    await screen.rerender(
      <MessagesTimeline
        {...base}
        routeThreadKey={other}
        timelineEntries={replies}
        liveFollowEnabled={false}
        findOpen
        findExpanded
        findQuery="Needle"
        activeFindMatch={{ entryId: "entry-r-5", runId: null, occurrence: 0 }}
      />,
    );
    const viewport = base.listRef.current!.getScrollableNode()!;
    await vi.waitFor(() => {
      const row = screen.container.querySelector('[data-timeline-row-id="entry-r-5"]');
      expect(row).not.toBeNull();
      const bounds = viewport.getBoundingClientRect();
      const top = row!.getBoundingClientRect().top;
      expect(top).toBeGreaterThanOrEqual(bounds.top);
      expect(top).toBeLessThan(bounds.bottom);
    });
  });
});
