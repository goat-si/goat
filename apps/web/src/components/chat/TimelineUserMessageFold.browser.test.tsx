import { EnvironmentId, MessageId, ThreadId } from "@goat/contracts";
import { serializeAssistantCitation } from "@goat/shared/assistantCitations";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { click, message, renderTimeline } from "./MessagesTimeline.browserHarness";

const environmentQuery = vi.hoisted(() => ({
  error: null as string | null,
  data: null as unknown,
}));
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: environmentQuery.data,
    dataUpdatedAt: 0,
    error: environmentQuery.error,
    failure: null,
    isPending: false,
    isSuccess: false,
    refresh: () => {},
  })) as never,
}));

const lines = (count: number) =>
  Array.from({ length: count }, (_, index) => `Line ${index}`).join("\n");

describe("folding a long user message", () => {
  it("folds a user message only when the fold hides at least as much as it shows", async () => {
    await using screen = await renderTimeline([
      message(lines(12), {}, "medium"),
      message(lines(60), {}, "long"),
    ]);
    await vi.waitFor(() => expect(screen.buttons("Show full message")).toHaveLength(1));
    const [medium, long] = [
      ...screen.container.querySelectorAll<HTMLElement>("[data-user-message-body]"),
    ];
    expect(medium!.dataset.userMessageCollapsible).toBe("false");
    expect(medium!.textContent).toContain("Line 11");
    const foldedHeight = long!.offsetHeight;
    await click(screen.button("Show full message"));
    expect(long!.offsetHeight).toBeGreaterThanOrEqual(foldedHeight * 2);
  });
});

/** Whether a person can see the sentence: it lies inside the body's shown box, not under the fold. */
function lastSentenceShown(body: HTMLElement, sentence: string): boolean {
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const at = node.textContent?.lastIndexOf(sentence) ?? -1;
    if (at < 0) continue;
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + sentence.length);
    return range.getBoundingClientRect().bottom <= body.getBoundingClientRect().bottom;
  }
  return false;
}

describe("folding by what the message shows", () => {
  const quote = "A long assistant paragraph that the user quoted. ".repeat(40);
  const card = serializeAssistantCitation({
    version: 1,
    environmentId: EnvironmentId.make("environment"),
    threadId: ThreadId.make("thread"),
    messageId: MessageId.make("source"),
    text: quote,
    start: 0,
    end: quote.length,
    prefix: "",
    suffix: "",
  });

  it("measures quotes by their cards: two do not fold, ten do", async () => {
    await using screen = await renderTimeline([
      message(card.repeat(2), {}, "two-cards"),
      message(card.repeat(10), {}, "ten-cards"),
    ]);
    await vi.waitFor(() => expect(screen.buttons("Show full message")).toHaveLength(1));
    const [two, ten] = [
      ...screen.container.querySelectorAll<HTMLElement>("[data-user-message-body]"),
    ];
    expect(two!.dataset.userMessageCollapsible).toBe("false");
    expect(ten!.dataset.userMessageCollapsible).toBe("true");
  });

  it("folds one long paragraph", async () => {
    // A phone-width column; a message folds only when its full height is twice the folded height.
    await page.viewport(414, 896);
    await using screen = await renderTimeline([
      message(`Can you expand on this? ${"More text. ".repeat(200)}The end.`, {}, "long-paragraph"),
      message(`Can you expand on this? ${"More text. ".repeat(60)}The end.`, {}, "short-paragraph"),
    ]);
    await vi.waitFor(() => expect(screen.buttons("Show full message")).toHaveLength(1));
    const [long, short] = [
      ...screen.container.querySelectorAll<HTMLElement>("[data-user-message-body]"),
    ];
    expect(long!.dataset.userMessageCollapsed).toBe("true");
    expect(lastSentenceShown(long!, "The end.")).toBe(false);
    expect(short!.dataset.userMessageCollapsible).toBe("false");
    expect(lastSentenceShown(short!, "The end.")).toBe(true);
  });
});
