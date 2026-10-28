import "~/index.css";

import { act } from "react";
import { expect, it, vi } from "vite-plus/test";

import { fakeTimers, render } from "../../../test/render";

vi.mock("~/hooks/useSettings", () => ({ usePrimarySettings: () => "system" }));
vi.mock("../settings/MemorySettings", () => ({ MemorySettingsEntry: () => null }));
vi.mock("./GoatBotAvatar", () => ({ GoatBotAvatar: () => null }));
vi.mock("./GoatBotTaskChip", () => ({ GoatBotTaskChip: () => null }));

import { GoatBotActivityContext, GoatBotTimeline } from "./GoatBotTimeline";

const now = Date.parse("2026-10-15T00:00:00Z");
const ago = (ms: number) => new Date(now - ms).toISOString();

function clock(): Disposable {
  const timers = fakeTimers();
  vi.setSystemTime(now);
  return timers;
}

it.each([90_000, 91_000])("never mounts the reading status when already %i ms old", async (age) => {
  using _timers = clock();
  const added: Element[] = [];
  const container = document.createElement("div");
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        added.push(...node.querySelectorAll('[role="status"]'));
        if (node.matches('[role="status"]')) added.push(node);
      }
    }
  });
  observer.observe(container, { childList: true, subtree: true });
  try {
    await using screen = await render(
      <GoatBotTimeline rows={[]} replyingSince={ago(age)} onRetry={() => {}} />,
      { container, router: false },
    );
    expect(screen.container.querySelector('[role="status"]')).toBeNull();
    await act(() => vi.runAllTimers());
    expect(added).toEqual([]);
  } finally {
    observer.disconnect();
  }
});

it("says it is reading until the limit and reads again for a newer message", async () => {
  using _timers = clock();
  // Router off: the timeline has no links and fake timers would stall the router's loader.
  await using screen = await render(
    <GoatBotTimeline rows={[]} replyingSince={ago(89_000)} onRetry={() => {}} />,
    { router: false },
  );
  const status = () => screen.container.querySelector('[role="status"]');
  expect(status()?.textContent).toBe("Reading your message");
  await act(() => vi.advanceTimersByTime(1_000));
  expect(status()).toBeNull();
  await screen.rerender(
    <GoatBotTimeline rows={[]} replyingSince={ago(-1_000)} onRetry={() => {}} />,
  );
  expect(status()?.textContent).toBe("Reading your message");
});

it.each([null, "invalid timestamp", ago(91_000)])(
  "removes the reading status as soon as replyingSince changes to %s",
  async (since) => {
    using _timers = clock();
    // Router off: the timeline has no links and fake timers would stall the router's loader.
    await using screen = await render(
      <GoatBotTimeline rows={[]} replyingSince={ago(0)} onRetry={() => {}} />,
      { router: false },
    );
    expect(screen.container.querySelector('[role="status"]')).not.toBeNull();
    await screen.rerender(<GoatBotTimeline rows={[]} replyingSince={since} onRetry={() => {}} />);
    expect(screen.container.querySelector('[role="status"]')).toBeNull();
  },
);

it("shows the acknowledged work's step after reading, past the reading limit", async () => {
  using _timers = clock();
  const timeline = (since: string | null) => (
    <GoatBotActivityContext value={{ state: "working", text: "Run df -h" }}>
      <GoatBotTimeline rows={[]} replyingSince={since} onRetry={() => {}} />
    </GoatBotActivityContext>
  );
  // Router off: the timeline has no links and fake timers would stall the router's loader.
  await using screen = await render(timeline(ago(89_000)), { router: false });
  const status = () => screen.container.querySelector('[role="status"]');
  expect(status()?.textContent).toBe("Reading your message");
  await act(() => vi.advanceTimersByTime(60_000));
  expect(status()?.textContent).toBe("Run df -h");
  await screen.rerender(timeline(null));
  expect(status()?.textContent).toBe("Run df -h");
});

/** The suite zeroes animation durations; the real stylesheet has to run to prove there are none. */
function withMotion(): Disposable {
  const noMotion = document.head.querySelector("style[data-test-no-motion]");
  noMotion?.remove();
  return { [Symbol.dispose]: () => void (noMotion && document.head.append(noMotion)) };
}

it("draws both activity states without any running animation", async () => {
  using _timers = clock();
  using _motion = withMotion();
  // Router off: nothing here links anywhere.
  await using screen = await render(
    <>
      <span data-testid="control" className="animate-spin" />
      <GoatBotActivityContext value={{ state: "working", text: "Working" }}>
        <GoatBotTimeline rows={[]} replyingSince={ago(0)} onRetry={() => {}} />
      </GoatBotActivityContext>
    </>,
    { router: false },
  );
  const control = screen.container.querySelector('[data-testid="control"]');
  expect(control?.getAnimations().length).toBeGreaterThan(0);
  const assertStill = (text: string) => {
    const status = screen.container.querySelector('[role="status"]');
    expect(status?.textContent).toBe(text);
    if (!(status instanceof HTMLElement)) throw new Error("expected the activity status");
    expect(status.getAnimations({ subtree: true })).toEqual([]);
    for (const element of [status, ...status.querySelectorAll("*")]) {
      for (const pseudo of [null, "::before", "::after"]) {
        expect(getComputedStyle(element, pseudo).animationName).toBe("none");
      }
    }
  };
  assertStill("Reading your message");
  await screen.rerender(
    <>
      <span data-testid="control" className="animate-spin" />
      <GoatBotActivityContext value={{ state: "working", text: "Working" }}>
        <GoatBotTimeline rows={[]} replyingSince={null} onRetry={() => {}} />
      </GoatBotActivityContext>
    </>,
  );
  assertStill("Working");
});
