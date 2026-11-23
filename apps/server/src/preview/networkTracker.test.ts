import * as NodeEvents from "node:events";
import { expect, it } from "vite-plus/test";
import type { Page, Request } from "playwright-core";
import { attachNetworkTracker, isMainNavigation, trackNavigation } from "./networkTracker.ts";

it("tracks a request whose navigation frame is not available yet without throwing", () => {
  const events = new NodeEvents.EventEmitter();
  const page = Object.assign(events, { mainFrame: () => ({}) }) as unknown as Page;
  const request = {
    isNavigationRequest: () => true,
    frame: () => {
      throw new Error("Frame unavailable");
    },
  } as unknown as Request;
  const tracker = attachNetworkTracker(page);
  expect(isMainNavigation(page, request)).toBe(false);
  expect(() => events.emit("request", request)).not.toThrow();
  expect(tracker.state().pendingRequests).toBe(1);
  expect(() => events.emit("requestfailed", request)).not.toThrow();
  expect(tracker.state().pendingRequests).toBe(0);
});

it("ignores direct app links and settles the navigation that redirected to one", () => {
  const frame = {};
  const page = { mainFrame: () => frame } as Page;
  const request = (url: string, previous: Request | null = null) =>
    ({
      isNavigationRequest: () => true,
      frame: () => frame,
      url: () => url,
      redirectedFrom: () => previous,
    }) as Request;
  const generations = new WeakMap<object, number>();
  const settled: Array<[number, string]> = [];
  const settle = (_tab: null, generation: number, url: string) => settled.push([generation, url]);
  const direct = request("obsidian://open");
  expect(trackNavigation(page, direct, generations, null, settle)).toBe(false);
  const open = request("https://example.com/open");
  expect(trackNavigation(page, open, generations, null, settle)).toBe(true);
  generations.set(open, 2);
  expect(trackNavigation(page, request("obsidian://open", open), generations, null, settle)).toBe(
    false,
  );
  expect(settled).toEqual([[2, "obsidian://open"]]);
});
