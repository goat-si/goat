import { InfoIcon } from "~/components/solar";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import "~/index.css";
import { render } from "../../../test/render";
import {
  ComposerBannerStack,
  NoticeText,
  type ComposerBannerStackItem,
} from "./ComposerBannerStack";

it("commits a dismissal when the thread switches during the exit transition", async () => {
  const onDismiss = vi.fn();
  const item: ComposerBannerStackItem = {
    id: "notice",
    variant: "info",
    icon: <InfoIcon />,
    title: "Thread A notice",
    dismissLabel: "Dismiss notice",
    onDismiss,
  };
  await using screen = await render(<ComposerBannerStack key="thread-a" items={[item]} />);

  await userEvent.click(screen.getByRole("button", { name: "Dismiss notice" }));
  // The composer keys the stack by thread, so switching threads remounts it mid-exit.
  await screen.rerender(<ComposerBannerStack key="thread-b" items={[]} />);

  await vi.waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1));
});

function noticeRow(width: string, children: ReactNode) {
  return (
    <div data-testid="row" className="flex items-center gap-1.5" style={{ width }}>
      <NoticeText detailsLabel="Show details" className="min-w-0 truncate">
        {children}
      </NoticeText>
    </div>
  );
}

it("leaves out the details button when only a link's hit area reaches past the text", async () => {
  // Phones lay out in device pixels, so a range can measure one float32 step (2^-17 px at
  // this size) wider than its element. Headless Chromium's rects agree exactly.
  const rangeRect = Range.prototype.getBoundingClientRect;
  using _rangeRect = vi
    .spyOn(Range.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: Range) {
      const rect = rangeRect.call(this);
      return new DOMRect(rect.x, rect.y, rect.width + 2 ** -17, rect.height);
    });
  // The flicker is a details button that mounts and then unmounts, so record every insertion.
  const inserted: Node[] = [];
  using observing = new DisposableStack();
  const mutations = new MutationObserver((records) =>
    inserted.push(...records.flatMap((record) => [...record.addedNodes])),
  );
  mutations.observe(document.body, { childList: true, subtree: true });
  observing.defer(() => mutations.disconnect());
  await using screen = await render(
    noticeRow(
      "20rem",
      <>
        Needs input{" "}
        <button type="button" className="relative after:absolute after:-inset-x-10 after:inset-y-0">
          Review
        </button>
      </>,
    ),
  );

  await expect.element(screen.getByText("Review")).toBeVisible();
  const details = [
    ...inserted,
    ...mutations.takeRecords().flatMap((record) => [...record.addedNodes]),
  ].filter(
    (node) =>
      node instanceof Element &&
      (node.matches('[aria-label="Show details"]') ||
        node.querySelector('[aria-label="Show details"]')),
  );
  expect(details).toEqual([]);
});

it("shows the details button while text or nested text is cut, until it fits again", async () => {
  await using screen = await render(noticeRow("4rem", "Waiting on a subagent with a long name"));
  const details = screen.getByRole("button", { name: "Show details" });
  await expect.element(details).toBeInTheDocument();

  screen.getByTestId("row").element().style.width = "40rem";
  await expect.element(details).not.toBeInTheDocument();

  await screen.rerender(
    noticeRow(
      "40rem",
      <span className="inline-block max-w-16 truncate align-bottom">A long nested name</span>,
    ),
  );
  await expect.element(details).toBeInTheDocument();
});
