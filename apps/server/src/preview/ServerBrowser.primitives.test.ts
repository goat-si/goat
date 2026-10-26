import * as NodeEvents from "node:events";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  EnvironmentId,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationFetchResult,
  type PreviewAutomationScrollCollectResult,
  type PreviewAutomationSnapshot,
  type PreviewAutomationStatus,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { BrowserContext, Page } from "playwright-core";
import { beforeEach, expect, vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import * as DesktopChannel from "./DesktopBrowserChannel.ts";
import * as Manager from "./Manager.ts";
import * as PreviewBrowser from "./PreviewBrowser.ts";
import * as ServerBrowser from "./ServerBrowser.ts";
import { makeSession } from "./ServerBrowserTestFixtures.ts";

vi.mock("./ServerBrowserContexts.ts", () => ({
  presentAsChrome: async () => {},
  ServerBrowserContexts: class {
    async contextFor() {
      const context = makeContext();
      contexts.push(context);
      return context as unknown as BrowserContext;
    }
    async scratchPage() {
      return makeContext().page as unknown as Page;
    }
    async connectDesktopPage() {
      const context = makeContext();
      return { browser: { close: async () => {} }, page: context.page as unknown as Page };
    }
    async close() {
      for (const context of contexts) await context.close();
    }
  },
}));

function makeContext() {
  const events = new NodeEvents.EventEmitter();
  const sessions: ReturnType<typeof makeSession>[] = [];
  let url = "https://app.example/feed";
  let height = 1_000;
  let scrolls = 0;
  const page = {
    on: (name: string, callback: (...args: unknown[]) => void) => events.on(name, callback),
    once: (name: string, callback: (...args: unknown[]) => void) => events.once(name, callback),
    off: (name: string, callback: (...args: unknown[]) => void) => events.off(name, callback),
    emit: (name: string, ...args: unknown[]) => events.emit(name, ...args),
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
    context: () => context,
    mainFrame: () => page,
    frames: () => [page],
    url: () => url,
    title: vi.fn(async () => "Feed"),
    viewportSize: () => ({ width: 1280, height: 800 }),
    setViewportSize: vi.fn(async () => {}),
    goto: vi.fn(async (next: string) => {
      url = next;
      events.emit("load");
    }),
    emulateMedia: vi.fn(async () => {}),
    waitForLoadState: vi.fn(async () => {}),
    waitForNavigation: vi.fn(async () => null),
    waitForTimeout: vi.fn(async () => {}),
    evaluate: vi.fn(async (expression: string) => {
      if (expression.includes("scrollingElement")) return height;
      if (expression.includes("DOMParser")) {
        return {
          url: "https://app.example/api/profile",
          status: 200,
          ok: true,
          contentType: "application/json",
          kind: "text",
          text: '{"user":"june","session":"SecretCookieValue99"}',
          truncated: false,
        };
      }
      return {
        url,
        title: "Feed",
        loading: false,
        visibleText: "Feed",
        interactiveElements: [],
      };
    }),
    ariaSnapshot: vi.fn(async () => '- button "More" [ref=e1]'),
    mouse: {
      click: vi.fn(async () => {}),
      move: vi.fn(async () => {}),
      wheel: vi.fn(async () => {
        scrolls += 1;
        height += 600;
        const items = [scrolls * 2 - 1, scrolls * 2];
        const body = Buffer.from(JSON.stringify(items));
        events.emit("response", {
          url: () => `https://app.example/api/items?page=${scrolls}`,
          status: () => 200,
          request: () => ({ method: () => "GET", failure: () => null }),
          headers: () => ({ "content-type": "application/json" }),
          body: async () => body,
          json: async () => items,
        });
      }),
    },
    isClosed: () => false,
    close: vi.fn(async () => {}),
  };
  const context = {
    page,
    sessions,
    cookies: vi.fn(async () => [{ name: "sid", value: "SecretCookieValue99" }]),
    newPage: async () => page as unknown as Page,
    grantPermissions: vi.fn(async () => {}),
    newCDPSession: async () => {
      const session = makeSession();
      sessions.push(session);
      return session;
    },
    close: vi.fn(async () => {}),
  };
  return context;
}

const contexts: ReturnType<typeof makeContext>[] = [];
const testThread = {
  threadId: ThreadId.make("primitives-test-thread"),
  providerSessionId: "agent-a",
  providerInstanceId: ProviderInstanceId.make("codex"),
};
const scope = {
  environmentId: EnvironmentId.make("primitives-test-env"),
  thread: testThread,
  client: undefined,
  requestNamespace: "primitives-test",
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};
const asSession = (providerSessionId: string) => ({
  ...scope,
  thread: { ...testThread, providerSessionId },
});

const dependencies = Layer.mergeAll(
  Manager.layer,
  Broker.layer,
  Layer.succeed(ServerEnvironment.ServerEnvironment, {
    getEnvironmentId: Effect.succeed(scope.environmentId),
    getDescriptor: Effect.die("unused descriptor"),
  }),
  Layer.succeed(PreviewBrowser.PreviewBrowser, {
    executable: Effect.die("unused executable"),
    installed: Effect.die("unused executable"),
  }),
  Layer.succeed(DesktopChannel.DesktopBrowserChannel, {
    available: false,
    awaitAttached: () => Effect.succeed(false),
    detached: Stream.empty,
    attached: Stream.empty,
    isAttached: () => Effect.succeed(false),
    endpoint: () => Effect.die("unused endpoint"),
    pointer: () => Effect.void,
  }),
).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "goat-browser-primitives-" })),
  Layer.provideMerge(NodeServices.layer),
);
const layer = ServerBrowser.layer.pipe(Layer.provideMerge(dependencies));

beforeEach(() => {
  contexts.length = 0;
});

it.live(
  "routes fetch as an observable read and scrollCollect as an action recorded in the timeline",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* ServerBrowser.ServerBrowser;
        const broker = yield* Broker.PreviewAutomationBroker;
        yield* Effect.yieldNow;
        const opened = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          operation: "open",
          input: { reuseExistingTab: false, show: false },
        });
        const tabId = PreviewTabId.make(opened.tabId!);

        // Another agent session can observe via fetch, with cookies redacted.
        const fetched = yield* broker.invoke<PreviewAutomationFetchResult>({
          scope: asSession("agent-b"),
          tabId,
          operation: "fetch",
          input: { url: "/api/profile" },
        });
        expect(fetched.status).toBe(200);
        expect(fetched.text).toContain('"user":"june"');
        expect(fetched.text).not.toContain("SecretCookieValue99");

        // Another agent session cannot scroll-collect on a tab it does not own.
        const denied = yield* broker
          .invoke<PreviewAutomationScrollCollectResult>({
            scope: asSession("agent-b"),
            tabId,
            operation: "scrollCollect",
            input: { url: "/api/items", minItems: 4 },
          })
          .pipe(Effect.flip);
        expect(denied).toMatchObject({
          _tag: "PreviewAutomationControlInterruptedError",
          reason: "agentMismatch",
        });

        // The owning agent session collects items across scrolls and records the action.
        const collected = yield* broker.invoke<PreviewAutomationScrollCollectResult>({
          scope,
          tabId,
          operation: "scrollCollect",
          input: { url: "/api/items", minItems: 4 },
        });
        expect(collected).toEqual({
          items: [1, 2, 3, 4],
          rounds: 2,
          responses: 2,
          stoppedBecause: "minItems",
        });

        const snapshot = yield* broker.invoke<PreviewAutomationSnapshot>({
          scope,
          tabId,
          operation: "snapshot",
          input: { captureImage: false },
        });
        expect(String(snapshot.accessibilityTree).startsWith("@layers none\n")).toBe(true);
        expect(snapshot.actionTimeline.map((entry) => entry.action)).toContain("scrollCollect");
      }),
    ).pipe(Effect.provide(layer)),
);
