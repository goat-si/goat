import "~/index.css";

import { act } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { fakeTimers, render } from "../../../test/render";

// The timeline renders Markdown through ChatMarkdown, which reads other settings exports.
vi.mock("~/hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/hooks/useSettings")>()),
  usePrimarySettings: () => "system",
}));
vi.mock("../settings/MemorySettings", () => ({ MemorySettingsEntry: () => null }));
vi.mock("./GoatBotAvatar", () => ({ GoatBotAvatar: () => null }));
vi.mock("./GoatBotTaskChip", () => ({ GoatBotTaskChip: () => null }));

import { GoatBotActivityStatus } from "./GoatBotActivityStatus";
import { GoatBotActivityContext, GoatBotTimeline } from "./GoatBotTimeline";

/** The chat view's pair: the status region mounts with the chat, the timeline beside it. */
function Chat({
  rows = [],
  replyingSince = null,
}: {
  readonly rows?: Parameters<typeof GoatBotTimeline>[0]["rows"];
  readonly replyingSince?: string | null;
}) {
  return (
    <>
      <GoatBotActivityStatus replyingSince={replyingSince} />
      <GoatBotTimeline rows={rows} replyingSince={replyingSince} onRetry={() => {}} />
    </>
  );
}

const now = Date.parse("2026-10-15T00:00:00Z");
const ago = (ms: number) => new Date(now - ms).toISOString();

function clock(): Disposable {
  const timers = fakeTimers();
  vi.setSystemTime(now);
  return timers;
}

it.each([90_000, 91_000])("never says it is reading a message already %i ms old", async (age) => {
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
    await using screen = await render(<Chat replyingSince={ago(age)} />, {
      container,
      router: false,
    });
    // The one status region is mounted empty; it never says it is reading an old message.
    const status = screen.container.querySelector('[role="status"]');
    expect(status?.textContent).toBe("");
    await act(() => vi.runAllTimers());
    expect(added.map((node) => node.textContent)).toEqual([""]);
    expect(status?.textContent).toBe("");
  } finally {
    observer.disconnect();
  }
});

it("says it is reading until the limit and reads again for a newer message", async () => {
  using _timers = clock();
  // Router off: the timeline has no links and fake timers would stall the router's loader.
  await using screen = await render(<Chat replyingSince={ago(89_000)} />, { router: false });
  const status = () => screen.container.querySelector('[role="status"]');
  expect(status()?.textContent).toBe("Reading your message");
  await act(() => vi.advanceTimersByTime(1_000));
  expect(status()?.textContent).toBe("");
  await screen.rerender(<Chat replyingSince={ago(-1_000)} />);
  expect(status()?.textContent).toBe("Reading your message");
});

it.each([null, "invalid timestamp", ago(91_000)])(
  "clears the reading status as soon as replyingSince changes to %s",
  async (since) => {
    using _timers = clock();
    // Router off: the timeline has no links and fake timers would stall the router's loader.
    await using screen = await render(<Chat replyingSince={ago(0)} />, { router: false });
    const status = () => screen.container.querySelector('[role="status"]')?.textContent;
    expect(status()).toBe("Reading your message");
    await screen.rerender(<Chat replyingSince={since} />);
    expect(status()).toBe("");
  },
);

it("shows the acknowledged work's step after reading, past the reading limit", async () => {
  using _timers = clock();
  const timeline = (since: string | null) => (
    <GoatBotActivityContext value={{ state: "working", text: "Run df -h" }}>
      <Chat replyingSince={since} />
    </GoatBotActivityContext>
  );
  // Router off: the timeline has no links and fake timers would stall the router's loader.
  await using screen = await render(timeline(ago(89_000)), { router: false });
  const status = () => screen.container.querySelector('[role="status"]');
  const step = () => screen.container.querySelector("button[aria-expanded]")?.textContent;
  expect(status()?.textContent).toBe("Reading your message");
  await act(() => vi.advanceTimersByTime(60_000));
  expect(step()).toBe("Run df -h");
  expect(status()?.textContent).toBe("GOAT Bot is working");
  await screen.rerender(timeline(null));
  expect(step()).toBe("Run df -h");
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
        <Chat replyingSince={ago(0)} />
      </GoatBotActivityContext>
    </>,
    { router: false },
  );
  const control = screen.container.querySelector('[data-testid="control"]');
  expect(control?.getAnimations().length).toBeGreaterThan(0);
  const assertStill = (text: string) => {
    const status = screen.container.querySelector('[role="status"]');
    expect(status?.textContent).toBe(text);
    // The step and its live status hold still; the face may fade once when its state changes.
    const step = screen.container.querySelector("button[aria-expanded]");
    if (!(status instanceof HTMLElement) || !(step instanceof HTMLElement))
      throw new Error("expected the activity line");
    expect([
      ...status.getAnimations({ subtree: true }),
      ...step.getAnimations({ subtree: true }),
    ]).toEqual([]);
    for (const element of [status, step, ...step.querySelectorAll("*")]) {
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
        <Chat replyingSince={null} />
      </GoatBotActivityContext>
    </>,
  );
  assertStill("GOAT Bot is working");
});

it("shows the bot's still face and the step it is on, announcing work once across steps", async () => {
  using _timers = clock();
  const line = (text: string) => (
    <GoatBotActivityContext value={{ state: "working", text, title: "Fix the login flow" }}>
      <Chat />
    </GoatBotActivityContext>
  );
  // Router off: the timeline has no links and fake timers would stall the router's loader.
  await using screen = await render(line("Running the tests"), { router: false });
  const status = () => screen.container.querySelector('[role="status"]')?.textContent;
  const step = screen.getByRole("button", { name: "Running the tests · Fix the login flow" });
  await expect.element(step).toBeVisible();
  expect(status()).toBe("GOAT Bot is working");
  expect(screen.container.querySelector('[data-face="working"]')).not.toBeNull();
  // No elapsed timer: the line stays as it was while time passes.
  await act(() => vi.advanceTimersByTime(90_000));
  expect(screen.container.textContent).not.toMatch(/\d+\s?[sm]\b/);
  await screen.rerender(line("Opening a pull request"));
  // A new step replaces the line; the live status says nothing new.
  await expect
    .element(screen.getByRole("button", { name: "Opening a pull request · Fix the login flow" }))
    .toBeVisible();
  expect(status()).toBe("GOAT Bot is working");
});

it("opens a cut-off step to its full text from the keyboard", async () => {
  const long = "Comparing the release notes of every package touched since the last tag";
  await using screen = await render(
    <div style={{ width: 240 }}>
      <GoatBotActivityContext value={{ state: "working", text: long, title: "Draft the notes" }}>
        <Chat />
      </GoatBotActivityContext>
    </div>,
    { router: false },
  );
  const step = screen.getByRole("button", { name: long + " · Draft the notes" });
  await expect.element(step).toHaveAttribute("aria-expanded", "false");
  const cut = step.element();
  expect(cut.scrollWidth).toBeGreaterThan(cut.clientWidth);
  (cut as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(step).toHaveAttribute("aria-expanded", "true");
  expect(cut.scrollWidth).toBeLessThanOrEqual(cut.clientWidth);
});

it("shows the waiting face and says so when the work is paused or waits on the person", async () => {
  for (const [text, attention, wait, heard] of [
    ["Paused on a usage limit", "paused", "usage_limit", "GOAT Bot is paused on a usage limit"],
    ["Waiting for your approval", "waiting", "you", "GOAT Bot is waiting for you"],
  ] as const) {
    await using screen = await render(
      <GoatBotActivityContext value={{ state: "working", text, attention, wait }}>
        <Chat />
      </GoatBotActivityContext>,
      { router: false },
    );
    expect(screen.container.querySelector('[data-face="waiting"]'), text).not.toBeNull();
    expect(screen.container.querySelector('[role="status"]')?.textContent).toBe(heard);
  }
});

it("says a wait on the person once while its wording changes", async () => {
  const timeline = (text: string) => (
    <GoatBotActivityContext value={{ state: "working", text, attention: "waiting", wait: "you" }}>
      <Chat />
    </GoatBotActivityContext>
  );
  await using screen = await render(timeline("Waiting for you"), { router: false });
  const region = screen.container.querySelector('[role="status"]');
  await vi.waitFor(() => expect(region?.textContent).not.toBe(""));
  const heard = region?.textContent;
  await screen.rerender(timeline("Waiting for your answer"));
  await expect
    .element(screen.getByRole("button", { name: "Waiting for your answer" }))
    .toBeVisible();
  expect(region?.textContent).toBe(heard);
});

it("keeps one status region and says when the work starts, waits, pauses and ends", async () => {
  using _timers = clock();
  const timeline = (
    activity: {
      state: "working";
      text: string;
      attention?: "waiting" | "paused";
      wait?: "you" | "other_work" | "usage_limit";
    } | null,
  ) => (
    <GoatBotActivityContext value={activity}>
      <Chat />
    </GoatBotActivityContext>
  );
  // Router off: the timeline has no links and fake timers would stall the router's loader.
  await using screen = await render(timeline(null), { router: false });
  const region = screen.container.querySelector('[role="status"]');
  expect(region?.textContent).toBe("");
  await screen.rerender(timeline({ state: "working", text: "Running the tests" }));
  expect(region?.textContent).toBe("GOAT Bot is working");
  await screen.rerender(
    timeline({ state: "working", text: "Waiting on other work", wait: "other_work" }),
  );
  // Waiting on other work needs nothing from the person.
  expect(region?.textContent).toBe("GOAT Bot is working");
  expect(screen.container.querySelector('[data-face="working"]')).not.toBeNull();
  await screen.rerender(
    timeline({
      state: "working",
      text: "Waiting for your approval",
      attention: "waiting",
      wait: "you",
    }),
  );
  expect(region?.textContent).toBe("GOAT Bot is waiting for you");
  expect(screen.container.querySelector('[data-face="waiting"]')).not.toBeNull();
  await screen.rerender(
    timeline({
      state: "working",
      text: "Paused on a usage limit",
      attention: "paused",
      wait: "usage_limit",
    }),
  );
  expect(region?.textContent).toBe("GOAT Bot is paused on a usage limit");
  await screen.rerender(timeline(null));
  expect(region?.textContent).toBe("GOAT Bot is done");
  // The same element carried every change, so a screen reader heard each one.
  expect(screen.container.querySelector('[role="status"]')).toBe(region);
});

it("opens a long step to its whole text and keeps the conversation where it was", async () => {
  const whole = "Comparing ".repeat(20) + "the end";
  const rows = Array.from({ length: 30 }, (_, index) => ({
    kind: "bot" as const,
    id: "m" + index,
    text: "Message " + index,
    createdAt: "2026-10-15T00:00:00.000Z",
    tone: "reply" as const,
    proactive: false,
    replyTo: null,
    options: [],
    firstInGroup: true,
    groupPosition: "single" as const,
  }));
  await using screen = await render(
    <div style={{ height: 300, display: "flex" }}>
      <GoatBotActivityContext
        value={{ state: "working", text: whole.slice(0, 119) + "…", fullText: whole }}
      >
        <GoatBotTimeline rows={rows} onRetry={() => {}} />
      </GoatBotActivityContext>
    </div>,
    { router: false },
  );
  const step = screen.getByRole("button", { name: /Comparing/ });
  await expect.element(step).toBeVisible();
  const scroller = step.element().closest(".overflow-y-auto") as HTMLElement;
  // A reader following the newest message sits at the bottom.
  await expect
    .poll(() => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight)
    .toBeLessThan(2);
  const before = scroller.scrollTop;
  (step.element() as HTMLElement).focus({ preventScroll: true });
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => step.element().textContent ?? "").toContain("the end");
  // The line grew, and the conversation stayed where it was instead of following the growth.
  expect(scroller.scrollHeight - scroller.clientHeight).toBeGreaterThan(before);
  expect(scroller.scrollTop).toBe(before);
});

it("opens an already-working chat with its status region empty, then says it is working", async () => {
  const container = document.createElement("div");
  const records: MutationRecord[] = [];
  const observer = new MutationObserver((batch) => records.push(...batch));
  observer.observe(container, { childList: true, subtree: true, characterData: true });
  try {
    await using screen = await render(
      <GoatBotActivityContext value={{ state: "working", text: "Running the tests" }}>
        <Chat />
      </GoatBotActivityContext>,
      { container, router: false },
    );
    const region = screen.container.querySelector('[role="status"]');
    await expect.poll(() => region?.textContent).toBe("GOAT Bot is working");
    records.push(...observer.takeRecords());
    // The words arrived as a change to the region already in the page, not inside its insertion.
    expect(
      records.some((record) => record.target === region || record.target.parentNode === region),
    ).toBe(true);
  } finally {
    observer.disconnect();
  }
});

it("says the work is done when it ends while a newer message is being read", async () => {
  using _timers = clock();
  const chat = (work: boolean, since: string | null) => (
    <GoatBotActivityContext value={work ? { state: "working", text: "Running the tests" } : null}>
      <Chat replyingSince={since} />
    </GoatBotActivityContext>
  );
  // Router off: the timeline has no links and fake timers would stall the router's loader.
  await using screen = await render(chat(true, null), { router: false });
  const status = () => screen.container.querySelector('[role="status"]')?.textContent;
  expect(status()).toBe("GOAT Bot is working");
  // The person sends another message while the work runs.
  await screen.rerender(chat(true, ago(0)));
  expect(status()).toBe("Reading your message");
  await screen.rerender(chat(false, ago(0)));
  expect(status()).toBe("Reading your message");
  await screen.rerender(chat(false, null));
  expect(status()).toBe("GOAT Bot is done");
  // A later reply with no work behind it says nothing more once it is read.
  await screen.rerender(chat(false, ago(-1_000)));
  expect(status()).toBe("Reading your message");
  await screen.rerender(chat(false, null));
  expect(status()).toBe("");
});

/** Resolves on each size change of the element, after the timeline's own observer handled it. */
function resizes(element: Element) {
  let seen = 0;
  const waiting: Array<{ readonly at: number; readonly resolve: () => void }> = [];
  const observer = new ResizeObserver(() => {
    seen += 1;
    for (const waiter of waiting.filter((entry) => entry.at <= seen)) waiter.resolve();
  });
  observer.observe(element);
  return {
    next: () => new Promise<void>((resolve) => waiting.push({ at: seen + 1, resolve })),
    [Symbol.dispose]: () => observer.disconnect(),
  };
}

const botRows = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    kind: "bot" as const,
    id: "m" + index,
    text: "Message " + index,
    createdAt: "2026-10-15T00:00:00.000Z",
    tone: "reply" as const,
    proactive: false,
    replyTo: null,
    options: [],
    firstInGroup: true,
    groupPosition: "single" as const,
  }));

const shortLineChat = (count: number) => (
  <div style={{ height: 300, display: "flex" }}>
    <GoatBotActivityContext value={{ state: "working", text: "Running the tests" }}>
      <GoatBotTimeline rows={botRows(count)} onRetry={() => {}} />
    </GoatBotActivityContext>
  </div>
);

async function toggleShortLine(screen: Awaited<ReturnType<typeof render>>) {
  const step = screen.getByRole("button", { name: "Running the tests" });
  await expect.element(step).toBeVisible();
  const scroller = step.element().closest(".overflow-y-auto") as HTMLElement;
  const list = scroller.querySelector("ol") as HTMLElement;
  await expect
    .poll(() => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight)
    .toBeLessThan(2);
  const heightBefore = scroller.scrollHeight;
  (step.element() as HTMLElement).focus({ preventScroll: true });
  await userEvent.keyboard("{Enter}");
  await expect.element(step).toHaveAttribute("aria-expanded", "true");
  // A short line opens without changing the conversation's height.
  expect(scroller.scrollHeight).toBe(heightBefore);
  const reply = async () => {
    using sizes = resizes(list);
    await sizes.next();
    await screen.rerender(shortLineChat(31));
    await sizes.next();
  };
  return { scroller, reply };
}

it("lets the reader's own scroll stand after a short line toggles, when a reply arrives", async () => {
  await using screen = await render(shortLineChat(30), { router: false });
  const { scroller, reply } = await toggleShortLine(screen);
  scroller.scrollTop = 0;
  await act(() => scroller.dispatchEvent(new Event("scroll")));
  await reply();
  expect(scroller.scrollTop).toBe(0);
});

it("still follows a reply after a short line toggles for a reader at the bottom", async () => {
  await using screen = await render(shortLineChat(30), { router: false });
  const { reply, scroller } = await toggleShortLine(screen);
  await reply();
  expect(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight).toBeLessThan(2);
});
