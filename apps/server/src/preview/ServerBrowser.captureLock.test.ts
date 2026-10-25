import * as NodeEvents from "node:events";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  EnvironmentId,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationLogs,
  type PreviewAutomationStatus,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { BrowserContext, Page } from "playwright-core";
import { expect, vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import * as DesktopChannel from "./DesktopBrowserChannel.ts";
import * as Manager from "./Manager.ts";
import * as PreviewBrowser from "./PreviewBrowser.ts";
import * as ServerBrowser from "./ServerBrowser.ts";
import { makeSession } from "./ServerBrowserTestFixtures.ts";

// One fake Chromium context per test: the page answers everything but what a test withholds.
const contexts: Array<ReturnType<typeof makeContext>> = [];

vi.mock("./ServerBrowserContexts.ts", () => ({
  presentAsChrome: async () => {},
  ServerBrowserContexts: class {
    async contextFor() {
      const context = makeContext();
      contexts.push(context);
      return context as unknown as BrowserContext;
    }
    // The recording encoder page: it accepts every frame.
    async scratchPage() {
      return { evaluate: async () => true, close: async () => {} } as unknown as Page;
    }
    async connectDesktopPage(): Promise<never> {
      throw new Error("no desktop here");
    }
    async close() {}
  },
}));

function makeContext() {
  const events = new NodeEvents.EventEmitter();
  let url = "about:blank";
  let viewport = { width: 1280, height: 800 };
  const page = {
    on: (name: string, callback: (...args: unknown[]) => void) => events.on(name, callback),
    once: (name: string, callback: (...args: unknown[]) => void) => events.once(name, callback),
    off: (name: string, callback: (...args: unknown[]) => void) => events.off(name, callback),
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
    context: () => context,
    mainFrame: () => page,
    frames: () => [page],
    url: () => url,
    title: async () => "test page",
    viewportSize: () => viewport,
    setViewportSize: async (size: typeof viewport) => {
      viewport = size;
    },
    goto: async (next: string) => {
      url = next;
      events.emit("load");
    },
    emulateMedia: async () => {},
    waitForLoadState: async () => {},
    evaluate: async () => ({
      url,
      title: "test page",
      loading: false,
      visibleText: "",
      interactiveElements: [],
    }),
    ariaSnapshot: async () => "",
    isClosed: () => false,
    close: async () => {},
  };
  const sessions: Array<ReturnType<typeof makeSession>> = [];
  const context = {
    page,
    sessions,
    newPage: async () => page as unknown as Page,
    grantPermissions: async () => {},
    newCDPSession: async (_target: unknown) => {
      const session = makeSession();
      sessions.push(session);
      return session;
    },
    close: async () => {},
  };
  return context;
}

const scope = {
  environmentId: EnvironmentId.make("capture-test-environment"),
  thread: {
    threadId: ThreadId.make("capture-test-thread"),
    providerSessionId: "agent-a",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  requestNamespace: "capture-test",
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};

const layer = ServerBrowser.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      Broker.layer,
      Manager.layer,
      Layer.succeed(ServerEnvironment.ServerEnvironment, {
        getEnvironmentId: Effect.succeed(scope.environmentId),
        getDescriptor: Effect.die("unused descriptor"),
      }),
      Layer.succeed(PreviewBrowser.PreviewBrowser, {
        executable: Effect.die("mock Chromium does not need an executable"),
        installed: Effect.die("mock Chromium does not need an executable"),
      }),
      Layer.succeed(DesktopChannel.DesktopBrowserChannel, {
        available: false,
        awaitAttached: () => Effect.succeed(false),
        detached: Stream.empty,
        attached: Stream.empty,
        isAttached: () => Effect.succeed(false),
        endpoint: () => Effect.die("no desktop here"),
        pointer: () => Effect.void,
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "goat-capture-lock-" })),
      Layer.provideMerge(NodeServices.layer),
    ),
  ),
);

it.live(
  "a viewer still the page never draws leaves snapshots their own deadline and other calls running",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const browser = yield* ServerBrowser.ServerBrowser;
        const broker = yield* Broker.PreviewAutomationBroker;
        yield* Effect.yieldNow;
        const opened = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          operation: "open",
          input: { reuseExistingTab: false, show: false },
        });
        const tabId = PreviewTabId.make(opened.tabId!);
        const context = contexts.at(-1)!;
        const drawn = Promise.withResolvers<Record<string, unknown>>();
        yield* Effect.addFinalizer(() => Effect.sync(() => drawn.resolve({ data: "" })));
        // A desktop guest parked outside the window answers no screenshot, the opening still
        // a viewer takes included.
        context.newCDPSession = async () => {
          const session = makeSession();
          const answer = session.send.getMockImplementation()!;
          session.send.mockImplementation((method, input) =>
            method === "Page.captureScreenshot" ? drawn.promise : answer(method, input),
          );
          return session;
        };
        yield* browser
          .attachViewer({
            threadId: scope.thread.threadId,
            tabId,
            canOperate: false,
            maxWidth: 1280,
            maxHeight: 800,
            quality: 70,
          })
          .pipe(Effect.forkScoped);
        const error = yield* broker
          .invoke<void>({ scope, tabId, operation: "snapshot", input: {}, timeoutMs: 200 })
          .pipe(Effect.flip);
        // The server browser answered on the request's deadline, before the broker gave up on
        // it and cut off every agent's tabs.
        expect(error).toMatchObject({
          _tag: "PreviewAutomationTimeoutError",
          timeoutMs: 200,
          remoteTag: "PreviewAutomationTimeoutError",
        });
        const title = yield* broker.invoke({
          scope,
          tabId,
          operation: "evaluate",
          input: { expression: "document.title" },
        });
        expect(title).toBe("evaluated");
        yield* broker.invoke<PreviewAutomationLogs>({ scope, tabId, operation: "logs", input: {} });
      }),
    ).pipe(Effect.provide(layer)),
);
it.live("a snapshot that gave up keeps its capture's place until Chromium answers it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* Broker.PreviewAutomationBroker;
      yield* Effect.yieldNow;
      const opened = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "open",
        input: { reuseExistingTab: false, show: false },
      });
      const tabId = PreviewTabId.make(opened.tabId!);
      const cdp = contexts.at(-1)!.sessions[0]!;
      const answer = cdp.send.getMockImplementation()!;
      const drawn = Promise.withResolvers<Record<string, unknown>>();
      yield* Effect.addFinalizer(() => Effect.sync(() => drawn.resolve({ data: "" })));
      cdp.send.mockImplementation((method, input) =>
        method === "Page.captureScreenshot" ? drawn.promise : answer(method, input),
      );
      const snapshot = broker
        .invoke<void>({ scope, tabId, operation: "snapshot", input: {}, timeoutMs: 200 })
        .pipe(Effect.flip);
      expect(yield* snapshot).toMatchObject({ remoteTag: "PreviewAutomationTimeoutError" });
      // The first capture is still in flight; a second one beside it is what crashes a guest
      // whose renderer exits mid-copy, so the next snapshot waits and answers on its deadline.
      expect(yield* snapshot).toMatchObject({ remoteTag: "PreviewAutomationTimeoutError" });
      const captures = cdp.send.mock.calls.filter(
        ([method]) => method === "Page.captureScreenshot",
      );
      expect(captures).toHaveLength(1);
    }),
  ).pipe(Effect.provide(layer)),
);
it.live(
  "a recording start behind a capture Chromium never answers answers on its own deadline",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* Broker.PreviewAutomationBroker;
        yield* Effect.yieldNow;
        const opened = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          operation: "open",
          input: { reuseExistingTab: false, show: false },
        });
        const tabId = PreviewTabId.make(opened.tabId!);
        const cdp = contexts.at(-1)!.sessions[0]!;
        const answer = cdp.send.getMockImplementation()!;
        const drawn = Promise.withResolvers<Record<string, unknown>>();
        yield* Effect.addFinalizer(() => Effect.sync(() => drawn.resolve({ data: "" })));
        cdp.send.mockImplementation((method, input) =>
          method === "Page.captureScreenshot" ? drawn.promise : answer(method, input),
        );
        yield* broker
          .invoke<void>({ scope, tabId, operation: "snapshot", input: {}, timeoutMs: 200 })
          .pipe(Effect.flip);
        const started = yield* broker
          .invoke<void>({ scope, tabId, operation: "recordingStart", input: {}, timeoutMs: 200 })
          .pipe(Effect.flip);
        // Answered by the server browser, not cut off by the broker with every other agent's tabs.
        expect(started).toMatchObject({ remoteTag: "PreviewAutomationTimeoutError" });
        expect(
          yield* broker.invoke({ scope, tabId, operation: "evaluate", input: { expression: "1" } }),
        ).toBe("evaluated");
      }),
    ).pipe(Effect.provide(layer)),
);
it.live("a recording start that outlives its caller's deadline can still be stopped", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* Broker.PreviewAutomationBroker;
      yield* Effect.yieldNow;
      const opened = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "open",
        input: { reuseExistingTab: false, show: false },
      });
      const tabId = PreviewTabId.make(opened.tabId!);
      const cdp = contexts.at(-1)!.sessions[0]!;
      const answer = cdp.send.getMockImplementation()!;
      const drawn = Promise.withResolvers<Record<string, unknown>>();
      yield* Effect.addFinalizer(() => Effect.sync(() => drawn.resolve({ data: "" })));
      // The start seeds the recording with a frame the page never draws.
      cdp.send.mockImplementation((method, input) =>
        method === "Page.captureScreenshot" ? drawn.promise : answer(method, input),
      );
      const call = (operation: "recordingStart" | "recordingStop") =>
        broker
          .invoke<void>({ scope, tabId, operation, input: {}, timeoutMs: 200 })
          .pipe(Effect.flip);
      expect(yield* call("recordingStart")).toMatchObject({
        remoteTag: "PreviewAutomationTimeoutError",
      });
      // The start is still on its way, so the stop waits behind it instead of finding nothing to
      // stop and leaving the recording to begin once the frame arrives.
      expect(yield* call("recordingStop")).toMatchObject({
        remoteTag: "PreviewAutomationTimeoutError",
      });
    }),
  ).pipe(Effect.provide(layer)),
);
it.live("a short call waiting behind a long one on the same tab answers on its own deadline", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* Broker.PreviewAutomationBroker;
      yield* Effect.yieldNow;
      const opened = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "open",
        input: { reuseExistingTab: false, show: false },
      });
      const tabId = PreviewTabId.make(opened.tabId!);
      const cdp = contexts.at(-1)!.sessions[0]!;
      const answer = cdp.send.getMockImplementation()!;
      const drawn = Promise.withResolvers<Record<string, unknown>>();
      const capturing = Promise.withResolvers<void>();
      yield* Effect.addFinalizer(() => Effect.sync(() => drawn.resolve({ data: "" })));
      cdp.send.mockImplementation((method, input) => {
        if (method !== "Page.captureScreenshot") return answer(method, input);
        capturing.resolve();
        return drawn.promise;
      });
      // The long snapshot holds the tab's agent queue for its whole 5 s budget.
      yield* broker
        .invoke<void>({ scope, tabId, operation: "snapshot", input: {}, timeoutMs: 5_000 })
        .pipe(Effect.exit, Effect.forkScoped);
      yield* Effect.promise(() => capturing.promise);
      const short = yield* broker
        .invoke<void>({
          scope,
          tabId,
          operation: "evaluate",
          input: { expression: "1" },
          timeoutMs: 200,
        })
        .pipe(Effect.flip);
      // Answered by the server browser, before the broker cut off the host with the long call.
      expect(short).toMatchObject({ remoteTag: "PreviewAutomationTimeoutError", timeoutMs: 200 });
    }),
  ).pipe(Effect.provide(layer)),
);
