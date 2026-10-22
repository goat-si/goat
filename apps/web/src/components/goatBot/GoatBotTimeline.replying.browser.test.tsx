import { fakeTimers } from "../../../test/render";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("~/hooks/useSettings", () => ({ usePrimarySettings: () => "system" }));
vi.mock("../settings/MemorySettings", () => ({ MemorySettingsEntry: () => null }));
vi.mock("./GoatBotAvatar", () => ({ GoatBotAvatar: () => null }));
vi.mock("./GoatBotTaskChip", () => ({ GoatBotTaskChip: () => null }));

import { GoatBotTimeline } from "./GoatBotTimeline";

let root: Root;
let container: HTMLDivElement;
let timers: Disposable;
const now = Date.parse("2026-10-15T00:00:00Z");

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  timers = fakeTimers();
  vi.setSystemTime(now);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  timers[Symbol.dispose]();
  vi.unstubAllGlobals();
});

it.each([90_000, 91_000])(
  "never mounts the replying status when already %i ms old",
  async (age) => {
    const addedStatuses: Element[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof Element) {
            addedStatuses.push(...node.querySelectorAll('[role="status"]'));
            if (node.matches('[role="status"]')) addedStatuses.push(node);
          }
        }
      }
    });
    observer.observe(container, { childList: true, subtree: true });
    try {
      await act(() =>
        root.render(
          <GoatBotTimeline
            rows={[]}
            replyingSince={new Date(now - age).toISOString()}
            onRetry={() => {}}
          />,
        ),
      );
      expect(container.querySelector('[role="status"]')).toBeNull();
      await act(() => vi.runAllTimers());
      expect(addedStatuses).toEqual([]);
    } finally {
      observer.disconnect();
    }
  },
);

it("expires a live reply and shows a new reply after the old one expires", async () => {
  const render = (since: number) =>
    root.render(
      <GoatBotTimeline
        rows={[]}
        replyingSince={new Date(since).toISOString()}
        onRetry={() => {}}
      />,
    );
  await act(() => render(now - 89_000));
  expect(container.querySelector('[role="status"]')?.getAttribute("aria-label")).toBe(
    "GOAT Bot is replying",
  );
  expect(container.querySelector(".goat-typing-tail")).not.toBeNull();
  expect(container.querySelectorAll('[role="status"] .animate-typing-wave')).toHaveLength(3);
  await act(() => vi.advanceTimersByTime(1_000));
  expect(container.querySelector('[role="status"]')).toBeNull();
  await act(() => render(now + 1_000));
  expect(container.querySelector('[role="status"]')).not.toBeNull();
});

it.each([null, "invalid timestamp", new Date(now - 91_000).toISOString()])(
  "removes a live status immediately when replyingSince changes to %s",
  async (since) => {
    await act(() =>
      root.render(
        <GoatBotTimeline
          rows={[]}
          replyingSince={new Date(now).toISOString()}
          onRetry={() => {}}
        />,
      ),
    );
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    await act(() =>
      root.render(<GoatBotTimeline rows={[]} replyingSince={since} onRetry={() => {}} />),
    );
    expect(container.querySelector('[role="status"]')).toBeNull();
  },
);
