import * as NodeEvents from "node:events";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { EnvironmentId, PreviewTabId, type PreviewAutomationStatus } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { BrowserContext, Page } from "playwright-core";
import { expect, vi } from "vite-plus/test";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as DesktopChannel from "./DesktopBrowserChannel.ts";
import * as Manager from "./Manager.ts";
import * as PreviewAgentActivity from "./PreviewAgentActivity.ts";
import * as PreviewBrowser from "./PreviewBrowser.ts";
import { unusedPreviewBrowser } from "./PreviewBrowser.testkit.ts";
import { historyMemoryLayer } from "./BrowserHistoryAssertions.testkit.ts";
import * as ServerBrowser from "./ServerBrowser.ts";
import { makeSession, scope } from "./ServerBrowserTestFixtures.ts";

const pages: Array<ReturnType<typeof makeContext>> = [];
// Holds page.goto until a test commits it, as a slow first load does.
let heldGoto: PromiseWithResolvers<void> | null = null;
vi.mock("./ServerBrowserContexts.ts", () => ({
  presentAsChrome: async () => {},
  ServerBrowserContexts: class {
    async contextFor() {
      const context = makeContext();
      pages.push(context);
      return context as unknown as BrowserContext;
    }
    storePin = async () => undefined;
    pinStore = async (_profileId: string, store: string) => store;
    withProfile = <A>(_profileId: string, run: () => Promise<A>) => run();
    async close() {}
  },
}));

function makeContext() {
  const events = new NodeEvents.EventEmitter();
  const sessions: Array<ReturnType<typeof makeSession>> = [];
  let url = "about:blank";
  let closed = false;
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
    setUrl: (next: string) => {
      url = next;
    },
    title: async () => "test page",
    viewportSize: () => ({ width: 1280, height: 800 }),
    setViewportSize: async () => {},
    goto: async (next: string) => {
      await heldGoto?.promise;
      url = next;
      events.emit("load");
    },
    emulateMedia: async () => {},
    isClosed: () => closed,
    close: async () => {
      if (closed) return;
      closed = true;
      events.emit("close");
    },
  };
  const context = {
    page,
    sessions,
    on: () => context,
    newPage: async () => page as unknown as Page,
    grantPermissions: async () => {},
    cookies: async () => [],
    newCDPSession: async () => {
      const session = makeSession();
      sessions.push(session);
      return session;
    },
    close: async () => page.close(),
  };
  return context;
}

const dependencies = Layer.mergeAll(
  ServerSettings.layerTest(),
  historyMemoryLayer,
  Broker.layer,
  Manager.layer,
  Layer.succeed(ServerEnvironment.ServerEnvironment, {
    getEnvironmentId: Effect.succeed(EnvironmentId.make("browser-test-environment")),
    getDescriptor: Effect.die("unused descriptor"),
  }),
  Layer.succeed(PreviewBrowser.PreviewBrowser, unusedPreviewBrowser),
  Layer.succeed(DesktopChannel.DesktopBrowserChannel, {
    available: false,
    awaitAttached: () => Effect.succeed(false),
    detached: Stream.never,
    attached: Stream.never,
    isAttached: () => Effect.succeed(false),
    endpoint: () => Effect.die("desktop is not used"),
    pointer: () => Effect.void,
    turn: () => Effect.void,
  }),
  PreviewAgentActivity.layer,
  Layer.mock(SecretRequests.SecretRequests)({}),
).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "goat-stop-loading-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);
const layer = ServerBrowser.layer.pipe(Layer.provideMerge(dependencies));

const navigationRequest = (page: ReturnType<typeof makeContext>["page"], url: string) => ({
  url: () => url,
  method: () => "GET",
  isNavigationRequest: () => true,
  frame: () => page,
  redirectedFrom: () => null,
  failure: () => ({ errorText: "net::ERR_ABORTED" }),
});

/** A server tab whose first load is still on its way, with an operating viewer on it. */
const openLoadingTab = Effect.gen(function* () {
  const browser = yield* ServerBrowser.ServerBrowser;
  const broker = yield* Broker.PreviewAutomationBroker;
  const manager = yield* Manager.PreviewManager;
  yield* Effect.yieldNow;
  heldGoto = Promise.withResolvers<void>();
  yield* Effect.addFinalizer(() => Effect.sync(() => heldGoto?.resolve()));
  const { tabId } = yield* manager.open({
    threadId: scope.thread.threadId,
    runtime: "server",
    url: "https://example.com/pending",
  });
  const viewer = yield* browser.attachViewer({
    threadId: scope.thread.threadId,
    tabId,
    canOperate: true,
    maxWidth: 1280,
    maxHeight: 800,
    quality: 70,
  });
  const context = pages.at(-1)!;
  const status = broker.invoke<PreviewAutomationStatus>({
    scope,
    tabId: PreviewTabId.make(tabId),
    operation: "status",
    input: {},
  });
  return { viewer, context, status };
});

it.effect.each([{ timing: "before" }, { timing: "after" }, { timing: "never" }] as const)(
  "Stop ends a first load whose request event comes $timing",
  ({ timing }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { viewer, context, status } = yield* openLoadingTab;
        const request = navigationRequest(context.page, "https://example.com/pending");
        if (timing === "before") context.page.emit("request", request);
        expect((yield* status).loading).toBe(true);

        yield* viewer.input({ type: "stopLoading" });
        if (timing === "after") context.page.emit("request", request);

        const stops = context.sessions.flatMap((session) =>
          session.send.mock.calls.filter(([method]) => method === "Page.stopLoading"),
        );
        expect(stops).toHaveLength(1);
        expect(yield* status).toMatchObject({ loading: false, url: null });
      }),
    ).pipe(Effect.provide(layer)),
);

it.effect("Stop on a committed page that is still loading reports the page it shows", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { viewer, context, status } = yield* openLoadingTab;
      context.page.emit("request", navigationRequest(context.page, "https://example.com/pending"));
      context.page.setUrl("https://example.com/pending");
      expect((yield* status).loading).toBe(true);

      yield* viewer.input({ type: "stopLoading" });
      // Chromium then fails the main request as aborted; that is the stop, not a download.
      context.page.emit(
        "requestfailed",
        navigationRequest(context.page, "https://example.com/pending"),
      );

      expect(yield* status).toMatchObject({
        loading: false,
        url: "https://example.com/pending",
      });
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect.each([{ operation: "navigate" }, { operation: "reload" }] as const)(
  "regression: an agent's $operation after a Stop that beat the first request loads",
  ({ operation }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { viewer, context, status } = yield* openLoadingTab;
        const broker = yield* Broker.PreviewAutomationBroker;
        yield* viewer.input({ type: "stopLoading" });
        expect((yield* status).loading).toBe(false);
        yield* viewer.input({ type: "releaseControl" });
        Object.assign(context.page, { reload: async () => {} });

        yield* broker.invoke({
          scope,
          tabId: PreviewTabId.make((yield* status).tabId!),
          operation,
          input: { url: "https://example.com/pending", readiness: "none" },
        });
        context.page.emit(
          "request",
          navigationRequest(context.page, "https://example.com/pending"),
        );

        expect((yield* status).loading).toBe(true);
      }),
    ).pipe(Effect.provide(layer)),
);

it.effect("an agent's Stop ends its tab's load through the same stop a person's Stop uses", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* ServerBrowser.ServerBrowser;
      const broker = yield* Broker.PreviewAutomationBroker;
      yield* Effect.yieldNow;
      heldGoto = null;
      const opened = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "open",
        input: { reuseExistingTab: false, show: false },
      });
      const tabId = PreviewTabId.make(opened.tabId!);
      const context = pages.at(-1)!;
      context.page.emit("request", navigationRequest(context.page, "https://example.com/slow"));
      const status = broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "status",
        input: {},
      });
      expect((yield* status).loading).toBe(true);

      const stopped = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "stopLoading",
        input: {},
      });

      const stops = context.sessions.flatMap((session) =>
        session.send.mock.calls.filter(([method]) => method === "Page.stopLoading"),
      );
      expect(stops).toHaveLength(1);
      expect(stopped).toMatchObject({ tabId, loading: false });
    }),
  ).pipe(Effect.provide(layer)),
);
