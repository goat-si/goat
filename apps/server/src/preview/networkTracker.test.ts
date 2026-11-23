import * as NodeEvents from "node:events";
import { expect, it } from "vite-plus/test";
import type { Page, Request } from "playwright-core";
import { attachNetworkTracker, isMainNavigation } from "./networkTracker.ts";

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
