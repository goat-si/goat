import { Atom, AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import "~/index.css";
import { act } from "../../../test/render";
import { MessagesTimeline } from "./MessagesTimeline";
import { resolveTimelineIsAtEnd } from "./MessagesTimeline.logic";
import {
  CREATED_AT,
  baseProps,
  click,
  message,
  renderElement,
} from "./MessagesTimeline.browserHarness";
import { makeStreamingTimelineFixture } from "../../test-fixtures";

const environmentQuery = vi.hoisted(() => ({
  data: null as unknown,
  error: null as string | null,
}));
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: environmentQuery.data,
    error: environmentQuery.error,
    dataUpdatedAt: 0,
    failure: null,
    isPending: false,
    isSuccess: false,
    refresh: () => {},
  })) as never,
}));
function setup() {
  environmentQuery.data = null;
  environmentQuery.error = null;
}

describe("revealing expanded work", () => {
  const revealModes = ["inline", "at-end", "delayed", "grouped-delayed", "grouped-end"];
  it.each(revealModes)("reveals %s output", async (mode) => {
    const inline = mode === "inline" || mode === "at-end";
    setup();
    environmentQuery.data =
      mode === "grouped-end"
        ? {
            output: { text: `${"output line\n".repeat(10)}TOOL_INPUT_END`, truncated: false },
            running: false,
          }
        : null;
    environmentQuery.error = null;
    const props = baseProps();
    const composerOverlayHeight = mode === "grouped-end" ? 140 : 200;
    const tallEntries = Array.from({ length: 12 }, (_, index) =>
      message(
        `Message ${index}\n\n${"Long paragraph. ".repeat(80)}`,
        { role: "assistant" },
        `tall-${index}`,
      ),
    );
    const projectedItem = makeStreamingTimelineFixture().visibleTurnItems[1]!;
    const source = {
      detail: () => Atom.make(AsyncResult.initial()),
      commandOutput: () => Atom.make(AsyncResult.initial()),
    };
    let outerGrowth = false;
    let routeThreadKey = props.routeThreadKey;
    const timeline = () => (
      <MessagesTimeline
        {...props}
        routeThreadKey={routeThreadKey}
        liveFollowEnabled={false}
        {...(inline
          ? {}
          : {
              turnItemSource: {
                detail: () => source.detail(),
                commandOutput: () => source.commandOutput(),
              },
            })}
        contentInsetEndAdjustment={composerOverlayHeight}
        timelineEntries={[
          ...tallEntries.slice(0, 6),
          {
            id: "tool-near-composer",
            kind: "work",
            createdAt: CREATED_AT,
            entry: {
              id: "tool-near-composer",
              createdAt: CREATED_AT,
              label: "Example tool",
              toolTitle: "Example tool",
              tone: "tool",
              itemType: "dynamic_tool",
              toolLifecycleStatus: "completed",
              toolData: { input: { query: `${"x".repeat(1200)} TOOL_INPUT_END` } },
              ...(inline
                ? {}
                : {
                    itemType: "command_execution",
                    projectedItem,
                    structuredPayload: projectedItem.item,
                  }),
            },
          },
          ...(mode.startsWith("grouped-")
            ? [
                {
                  id: "another-tool",
                  kind: "work" as const,
                  createdAt: CREATED_AT,
                  entry: {
                    id: "another-tool",
                    createdAt: CREATED_AT,
                    label: "Other tool",
                    tone: "tool" as const,
                    itemType: "dynamic_tool" as const,
                    toolLifecycleStatus: "completed" as const,
                    toolData: { input: { query: "other" } },
                  },
                },
              ]
            : []),
          ...(mode === "grouped-end"
            ? [message("Completed.", { role: "assistant" }, "final-message")]
            : mode === "at-end"
              ? [message("Done.", { role: "assistant" }, "final-message")]
              : tallEntries.slice(6)),
          ...(outerGrowth
            ? [message("Later output\n\n".repeat(20), { role: "assistant" }, "outer-growth")]
            : []),
        ]}
      />
    );
    await using screen = await renderElement(
      mode === "grouped-delayed" ? (
        <MessagesTimeline {...props} timelineEntries={[message("Previous thread")]} />
      ) : (
        timeline()
      ),
    );
    if (mode === "grouped-end") screen.container.style.height = "648px";
    await vi.waitFor(() => expect(props.listRef.current?.getScrollableNode()).toBeTruthy());
    const viewport = props.listRef.current!.getScrollableNode()!;
    if (mode === "grouped-delayed") {
      routeThreadKey = `${routeThreadKey}-switched`;
      await screen.rerender(timeline());
      await vi.waitFor(() => expect(viewport.scrollHeight).toBeGreaterThan(3000));
      await act(() => viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 })));
    }
    if (mode.startsWith("grouped-")) {
      await act(() => {
        void props.listRef.current!.scrollToIndex({ index: 6, animated: false });
      });
      await vi.waitFor(() =>
        expect(
          screen.container.querySelector('[data-timeline-row-kind="work-toggle"] [role="button"]'),
        ).not.toBeNull(),
      );
      const group = () =>
        screen.container.querySelector<HTMLElement>(
          '[data-timeline-row-kind="work-toggle"] [role="button"]',
        )!;
      await click(group());
      await vi.waitFor(() =>
        expect(
          screen.container.querySelector('[data-work-entry-id="tool-near-composer"]'),
        ).not.toBeNull(),
      );
      if (mode === "grouped-delayed") {
        await click(
          screen.container.querySelector<HTMLElement>('[data-work-entry-id="tool-near-composer"]')!,
        );
        await vi.waitFor(() => expect(screen.text()).toContain("Loading output"));
        await click(group());
      }
    }
    const header = () => {
      if (mode === "grouped-end")
        return screen.container.querySelector<HTMLElement>(
          '[data-work-entry-id="tool-near-composer"]',
        )!;
      if (mode === "grouped-delayed")
        return screen.container.querySelector<HTMLElement>(
          '[data-timeline-row-kind="work-toggle"] [role="button"]',
        )!;
      const rows = screen.container.querySelectorAll<HTMLElement>(
        '[data-timeline-row-kind="work"] [role="button"]',
      );
      if (!rows[0]) throw new Error(screen.text());
      return rows[0];
    };
    const visibleBottom = () => viewport.getBoundingClientRect().bottom - composerOverlayHeight;
    await act(() => {
      void props.listRef.current!.scrollToIndex({ index: 6, animated: false });
    });
    if (mode === "at-end") {
      await act(() => {
        void props.listRef.current!.scrollToEnd({ animated: false });
      });
      await vi.waitFor(() =>
        expect(resolveTimelineIsAtEnd(props.listRef.current!.getState())).toBe(true),
      );
    } else {
      await vi.waitFor(async () => {
        await act(() => {
          viewport.scrollTop += header().getBoundingClientRect().bottom - (visibleBottom() - 8);
          viewport.dispatchEvent(new Event("scroll"));
        });
        expect(resolveTimelineIsAtEnd(props.listRef.current!.getState())).toBe(false);
        expect(header().getBoundingClientRect().bottom).toBeLessThanOrEqual(visibleBottom());
        expect(header().getBoundingClientRect().top).toBeGreaterThan(
          viewport.getBoundingClientRect().top,
        );
      });
    }

    const collapsedScrollTop = viewport.scrollTop;
    using scrollBy = vi.spyOn(viewport, "scrollBy");
    // The nested row can measure before the outer scroller gains its new range.
    if (mode === "grouped-delayed") scrollBy.mockImplementationOnce(() => {});
    await click(header());
    if (mode === "grouped-delayed") {
      await vi.waitFor(() => expect(scrollBy).toHaveBeenCalled());
      outerGrowth = true;
      await screen.rerender(timeline());
      await vi.waitFor(() => expect(viewport.scrollTop).toBeGreaterThan(collapsedScrollTop));
    }
    if (!inline && mode !== "grouped-end") {
      await vi.waitFor(() =>
        expect(header().getBoundingClientRect().bottom).toBeLessThanOrEqual(visibleBottom() + 1),
      );
      await vi.waitFor(() => expect(screen.text()).toContain("Loading output"));
      environmentQuery.data = {
        output: { text: `${"output line\n".repeat(20)}TOOL_INPUT_END`, truncated: false },
        running: false,
      };
      await screen.rerender(timeline());
    }
    const inputEnd = () =>
      Array.from(screen.container.querySelectorAll<HTMLElement>("*")).findLast((element) =>
        element.textContent?.includes("TOOL_INPUT_END"),
      )!;
    await vi.waitFor(() =>
      expect(inputEnd().getBoundingClientRect().bottom).toBeLessThanOrEqual(visibleBottom() + 1),
    );
    await vi.waitFor(() =>
      expect(header().getBoundingClientRect().top).toBeGreaterThanOrEqual(
        viewport.getBoundingClientRect().top,
      ),
    );
  });
});
