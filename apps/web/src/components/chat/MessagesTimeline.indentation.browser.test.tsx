import { searchableMessageSegments } from "@goat/shared/threadFindText";
import { countThreadSearchOccurrences } from "@goat/shared/threadSearch";
import { expect, it, vi } from "vite-plus/test";
import "~/index.css";
import { MessagesTimeline } from "./MessagesTimeline";
import { baseProps, message, renderElement, type Entry } from "./MessagesTimeline.browserHarness";
import { collectThreadFindRanges } from "./threadFindHighlights";

it("shows and finds exact user indentation in live and prepended history", async () => {
  const source = "Plan\n   Step one\n\tDetail";
  const assistant = message(source, { role: "assistant" }, "assistant");
  const live = message(source, {}, "live-user");
  const historical = message(source, {}, "historical-user");
  const props = baseProps();
  const timeline = (entries: Entry[]) => <MessagesTimeline {...props} timelineEntries={entries} />;
  await using screen = await renderElement(timeline([live, assistant]));
  const userBody = (id: string) =>
    screen.container.querySelector<HTMLElement>(
      `[data-message-id="${id}"] [data-user-message-body]`,
    );
  await vi.waitFor(() => expect(userBody("live-user")?.innerText).toBe(source));
  expect(
    screen.container.querySelector<HTMLElement>('[data-message-id="assistant"] .chat-markdown')
      ?.innerText,
  ).toBe("Plan Step one Detail");

  await screen.rerender(timeline([historical, live, assistant]));
  await vi.waitFor(() => expect(userBody("historical-user")?.innerText).toBe(source));
  const query = "   Step one";
  const indexed = searchableMessageSegments({ role: "user", text: source, streaming: false });
  const ranges = collectThreadFindRanges(screen.container, query);
  expect(ranges.map(({ range }) => range.toString())).toEqual([query, query]);
  expect(
    indexed?.reduce((count, segment) => count + countThreadSearchOccurrences(segment, query), 0),
  ).toBe(1);
});
