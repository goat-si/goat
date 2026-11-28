import * as NodeEvents from "node:events";
import type { Page, Request } from "playwright-core";
import { expect, it } from "vite-plus/test";
import { attachNetworkTracker, isMainNavigation, trackNavigation } from "./networkTracker.ts";

const makeFakePage = () => {
  const listeners = new Map<string, Set<(...args: Array<unknown>) => void>>();
  const on = (event: string, listener: (...args: Array<unknown>) => void) => {
    const group = listeners.get(event) ?? new Set();
    group.add(listener);
    listeners.set(event, group);
  };
  const off = (event: string, listener: (...args: Array<unknown>) => void) => {
    listeners.get(event)?.delete(listener);
  };
  const once = (event: string, listener: (...args: Array<unknown>) => void) => {
    const wrapped = (...args: Array<unknown>) => {
      off(event, wrapped);
      listener(...args);
    };
    on(event, wrapped);
  };
  const emit = (event: string, ...args: Array<unknown>) => {
    for (const listener of Array.from(listeners.get(event) ?? [])) listener(...args);
  };
  const mainFrame = {};
  const page = {
    mainFrame: () => mainFrame,
    on,
    off,
    once,
  } as unknown as Page;
  return { emit, mainFrame, page };
};

const makeRequest = (input: {
  readonly url: string;
  readonly resourceType: string;
  readonly navigation?: boolean;
  readonly frame?: unknown;
}) =>
  ({
    url: () => input.url,
    resourceType: () => input.resourceType,
    isNavigationRequest: () => input.navigation === true,
    frame: () => input.frame ?? {},
  }) as unknown as Request;

it("ignores WebSocket, EventSource, ping, non-http noise schemes, and analytics beacons", () => {
  const { emit, mainFrame, page } = makeFakePage();
  const tracker = attachNetworkTracker(page);

  const nav = makeRequest({
    url: "https://app.example/dashboard",
    resourceType: "document",
    navigation: true,
    frame: mainFrame,
  });
  emit("request", nav);
  emit("framenavigated", mainFrame);
  emit("requestfinished", nav);
  expect(tracker.state()).toEqual({ documentId: 1, pendingRequests: 0, network: "idle" });

  const noiseRequests = [
    makeRequest({ url: "wss://app.example/live", resourceType: "websocket" }),
    makeRequest({ url: "https://app.example/events", resourceType: "eventsource" }),
    makeRequest({ url: "https://app.example/beacon", resourceType: "ping" }),
    makeRequest({ url: "https://www.google-analytics.com/g/collect", resourceType: "fetch" }),
    makeRequest({ url: "https://api.segment.io/v1/t", resourceType: "xhr" }),
    makeRequest({ url: "blob:https://app.example/123", resourceType: "fetch" }),
    makeRequest({ url: "data:text/plain,hello", resourceType: "other" }),
  ];

  for (const request of noiseRequests) emit("request", request);
  expect(tracker.state()).toEqual({ documentId: 1, pendingRequests: 0, network: "idle" });

  const apiRequest = makeRequest({ url: "https://app.example/api/data", resourceType: "fetch" });
  emit("request", apiRequest);
  expect(tracker.state()).toEqual({ documentId: 1, pendingRequests: 1, network: "busy" });

  emit("requestfinished", apiRequest);
  expect(tracker.state()).toEqual({ documentId: 1, pendingRequests: 0, network: "idle" });
});

it("still tracks data-url main-frame navigations as document navigations", () => {
  const { emit, mainFrame, page } = makeFakePage();
  const tracker = attachNetworkTracker(page);

  const dataNav = makeRequest({
    url: "data:text/html,<p>inline</p>",
    resourceType: "document",
    navigation: true,
    frame: mainFrame,
  });
  emit("request", dataNav);
  expect(tracker.state()).toEqual({ documentId: 0, pendingRequests: 1, network: "busy" });
  emit("framenavigated", mainFrame);
  emit("requestfinished", dataNav);
  expect(tracker.state()).toEqual({ documentId: 1, pendingRequests: 0, network: "idle" });
});

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
