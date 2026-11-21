import { scopedThreadKey } from "@goat/client-runtime/environment";
import { EnvironmentId, ThreadId, type OrchestrationV2SearchThreadInput } from "@goat/contracts";
import { searchableMessageSegments } from "@goat/shared/threadFindText";
import { countThreadSearchOccurrences } from "@goat/shared/threadSearch";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import ChatMarkdown from "../ChatMarkdown";
import { ThreadFindBar } from "./ThreadFindBar";
import { USER_MESSAGE_REMARK_PLUGINS } from "./TimelineUserMessageRow.logic";
import { collectThreadFindRanges } from "./threadFindHighlights";
import { closeThreadFind, openThreadFind } from "./threadFindStore";
import { useThreadFind } from "./useThreadFind";

const { find } = vi.hoisted(() => ({ find: vi.fn() }));
vi.mock("~/state/orchestration", () => ({ orchestrationEnvironment: { threadFind: find } }));

const thread = { environmentId: EnvironmentId.make("local"), threadId: ThreadId.make("find") };
const text = "Plan\nneedle\n   needle";

it("announces user search and navigation but keeps streamed count refreshes silent", async () => {
  const props = {
    open: true,
    query: "needle",
    matchCount: 3,
    counting: false,
    status: null,
    activeIndex: 0,
    focusRequestId: 1,
    navigationId: 1,
    settled: true,
    onRetry: () => {},
    onQueryChange: () => {},
    onNext: () => {},
    onPrevious: () => {},
    onClose: () => {},
  } as const;
  await using screen = await render(<ThreadFindBar {...props} />);
  const live = () => screen.container.querySelector('[aria-live="polite"]')?.textContent;
  expect(live()).toBe("1/3");
  await screen.rerender(<ThreadFindBar {...props} matchCount={4} />);
  expect(live()).toBe("1/3");
  await screen.rerender(
    <ThreadFindBar {...props} matchCount={4} activeIndex={1} navigationId={2} />,
  );
  expect(live()).toBe("2/4");
});

function Fixture({ literal }: { literal: boolean }) {
  const { barProps, timelineProps } = useThreadFind({
    thread,
    enabled: true,
    serverConfig: { threadFindLiteralQuery: literal },
  });
  return (
    <>
      <ThreadFindBar {...barProps} />
      <div data-timeline-row-id="prompt" data-find-query={timelineProps.findQuery}>
        <div data-thread-find-text>
          <ChatMarkdown
            text={text}
            cwd={undefined}
            lineBreaks
            parseRawHtml={false}
            extraRemarkPlugins={USER_MESSAGE_REMARK_PLUGINS}
          />
        </div>
      </div>
    </>
  );
}

it.each([
  { literal: true, query: "   needle", count: 1 },
  { literal: false, query: "needle", count: 2 },
])(
  "Find uses the query supported by the server (literal=$literal)",
  async ({ literal, query, count }) => {
    find
      .mockReset()
      .mockImplementation(({ input }: { input: OrchestrationV2SearchThreadInput }) => {
        const segments = searchableMessageSegments({ role: "user", text, streaming: false }) ?? [];
        const totalMatches = segments.reduce(
          (total, segment) => total + countThreadSearchOccurrences(segment, input.query),
          0,
        );
        return Atom.make(
          AsyncResult.success({
            totalMatches,
            activeIndex: 0,
            match: { entryId: "prompt", runId: null, occurrence: 0 },
          }),
        );
      });
    using _find = { [Symbol.dispose]: closeThreadFind };
    openThreadFind(scopedThreadKey(thread));
    await using screen = await render(<Fixture literal={literal} />);
    await userEvent.fill(screen.getByRole("searchbox", { name: "Find in thread" }), "   needle");
    await expect.element(screen.getByText(`1/${count}`).last()).toBeVisible();
    await expect
      .element(screen.getByText(`1/${count}`).last())
      .toHaveAttribute("aria-hidden", "true");
    const row = screen.container.querySelector<HTMLElement>("[data-find-query]");
    expect(row?.dataset.findQuery).toBe(query);
    expect(
      collectThreadFindRanges(screen.container, query).map(({ range }) => range.toString()),
    ).toEqual(Array.from({ length: count }, () => query));
    expect(collectThreadFindRanges(screen.container, "    needle")).toEqual([]);
  },
);
