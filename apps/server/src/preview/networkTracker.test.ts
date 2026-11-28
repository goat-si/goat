import type { Page, Request } from "playwright-core";
import { expect, it } from "vite-plus/test";
import { attachNetworkTracker } from "./networkTracker.ts";

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
