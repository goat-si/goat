import * as NodeEvents from "node:events";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  EnvironmentId,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
  type AgentCursorSnapshot,
  type PreviewAutomationStatus,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { BrowserContext, Page } from "playwright-core";
import { expect, vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import * as DesktopChannel from "./DesktopBrowserChannel.ts";
import * as Manager from "./Manager.ts";
import * as PreviewBrowser from "./PreviewBrowser.ts";
import { unusedPreviewBrowser } from "./PreviewBrowser.testkit.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as PreviewAgentActivity from "./PreviewAgentActivity.ts";
import * as ServerBrowser from "./ServerBrowser.ts";
import { nextPointerSequence } from "./ServerBrowserScreen.ts";

it("pointer sequence reaches the last published cursor state", () => {
  const cursor = {
    phase: "thinking",
    identity: {
      environmentId: EnvironmentId.make("env"),
      runId: "run",
      turnId: "turn",
      targetId: "tab",
      generation: 1,
      sequence: 17,
    },
  } satisfies AgentCursorSnapshot;
  expect(nextPointerSequence(3, cursor)).toBe(17);
  expect(nextPointerSequence(17, cursor)).toBe(18);
});
import { makeSession } from "./ServerBrowserTestFixtures.ts";

// One fake Chromium context per test; its page refuses every locator, so input never lands.
const contexts: Array<ReturnType<typeof makeContext>> = [];
const privacy = vi.hoisted(() => ({ setters: [] as Array<(on: boolean) => void> }));
// Tells a test when the browser took a call, which starts that call's deadline.
const calls = vi.hoisted(() => ({
  received: undefined as ((timeoutMs: number) => void) | undefined,
}));

vi.mock("./CaptureLock.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./CaptureLock.ts")>();
  return {
    ...actual,
    answerCall: <A>(
      request: Parameters<typeof actual.answerCall>[0],
      call: (deadlineMs: number) => Promise<A>,
    ) => {
      calls.received?.(request.timeoutMs);
      return actual.answerCall(request, call);
    },
  };
});

vi.mock("./PreviewPrivateMode.ts", () => ({
  watchPrivateMode: async (_page: unknown, onChange: (on: boolean) => void) => {
    privacy.setters.push(onChange);
  },
}));

vi.mock("./ServerBrowserContexts.ts", () => ({
  presentAsChrome: async () => {},
  ServerBrowserContexts: class {
    async contextFor() {
      const context = makeContext();
      contexts.push(context);
      return context as unknown as BrowserContext;
    }
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
    goto: vi.fn(async (next: string) => {
      url = next;
      events.emit("load");
    }),
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
    locator: vi.fn(() => {
      throw new Error("Unexpected locator action");
    }),
    isClosed: () => false,
    close: async () => {},
  };
  const context = {
    page,
    newPage: async () => page as unknown as Page,
    grantPermissions: async () => {},
    newCDPSession: async (_target: unknown) => makeSession(),
    close: async () => {},
  };
  return context;
}

const scope = {
  environmentId: EnvironmentId.make("browser-screen-test-environment"),
  thread: {
    threadId: ThreadId.make("browser-screen-test-thread"),
    providerSessionId: "agent-a",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  requestNamespace: "browser-screen-test",
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
      Layer.succeed(PreviewBrowser.PreviewBrowser, unusedPreviewBrowser),
      Layer.succeed(DesktopChannel.DesktopBrowserChannel, {
        available: false,
        awaitAttached: () => Effect.succeed(false),
        detached: Stream.empty,
        attached: Stream.empty,
        isAttached: () => Effect.succeed(false),
        endpoint: () => Effect.die("no desktop here"),
        turn: () => Effect.void,
        pointer: () => Effect.void,
      }),
      PreviewAgentActivity.layer,
      ServerSettings.layerTest(),
      Layer.mock(SecretRequests.SecretRequests)({}),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "goat-browser-screen-" })),
      Layer.provideMerge(NodeServices.layer),
    ),
  ),
);

const ready = Effect.gen(function* () {
  const broker = yield* Broker.PreviewAutomationBroker;
  yield* ServerBrowser.ServerBrowser;
  yield* Effect.yieldNow;
  const opened = yield* broker.invoke<PreviewAutomationStatus>({
    scope,
    operation: "open",
    input: { reuseExistingTab: false, show: false },
  });
  const tabId = PreviewTabId.make(opened.tabId!);
  return { broker, tabId };
});

it.effect("refuses a blocked navigation before sending it to the page", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({ blockedBrowserHosts: ["example.com"] });
      const page = contexts.at(-1)!.page;
      const result = yield* broker
        .invoke({ scope, tabId, operation: "navigate", input: { url: "https://a.example.com/" } })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({ reason: "blocked_url", dispatched: false });
      expect(page.goto).not.toHaveBeenCalled();
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("refuses an initial blocked URL before opening a tab", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker } = yield* ready;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({ blockedBrowserHosts: ["example.com"] });
      const count = contexts.length;
      const result = yield* broker
        .invoke({
          scope,
          operation: "open",
          input: { reuseExistingTab: false, show: false, url: "https://example.com/" },
        })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({ reason: "blocked_url", dispatched: false });
      expect(contexts).toHaveLength(count);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("refuses input when the tab currently shows a blocked host", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({ blockedBrowserHosts: ["example.com"] });
      const page = contexts.at(-1)!.page;
      yield* Effect.promise(() => page.goto("https://example.com/"));
      const result = yield* broker
        .invoke({
          scope,
          tabId,
          operation: "click",
          input: { locator: "button" },
        })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({ reason: "blocked_url", dispatched: false });
      expect(page.locator).not.toHaveBeenCalled();
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("a queued input cannot dispatch after its expected control generation changes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const bound = (yield* broker.listBoundTabs(scope)).find((tab) => tab.tabId === tabId);
      expect(bound).toBeDefined();
      if (!bound) return;
      const result = yield* broker
        .invoke({
          scope,
          operation: "click",
          input: { locator: "aria-ref=stale" },
          exact: {
            browserInstanceId: bound.browserInstanceId,
            connectionId: bound.connectionId,
            tabId,
            controlGeneration: bound.controlGeneration + 1,
            origin: null,
          },
        })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(contexts[0]?.page.locator).not.toHaveBeenCalled();
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("an agent cannot close its own tab while a private field has focus", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const setPrivate = privacy.setters.at(-1);
      expect(setPrivate).toBeDefined();
      setPrivate?.(true);
      const result = yield* broker
        .invoke({ scope, operation: "close", input: {}, tabId })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({
          _tag: "PreviewAutomationControlInterruptedError",
          reason: "privateMode",
        });
      expect((yield* broker.listBoundTabs(scope)).some((tab) => tab.tabId === tabId)).toBe(true);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect.each([
  { queuedMs: 900, outcome: "waits only the 100 ms its call has left" },
  { queuedMs: 2_000, outcome: "fails as never started, without checking the condition" },
])("a wait queued $queuedMs ms behind other work on its tab $outcome", ({ queuedMs }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      let clock = 0;
      using _now = vi.spyOn(performance, "now").mockImplementation(() => clock);
      const page = contexts.at(-1)!.page;
      const holding = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const timeouts: number[] = [];
      page.waitForLoadState = vi.fn(async (_state?: string, options?: { timeout?: number }) => {
        if (timeouts.push(options?.timeout ?? Number.NaN) > 1) return;
        holding.resolve();
        await release.promise;
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => release.resolve()));
      const wait = (timeoutMs: number) =>
        broker.invoke({
          scope,
          tabId,
          operation: "waitFor",
          input: { loadState: "load" },
          timeoutMs,
        });
      const first = yield* wait(15_000).pipe(Effect.forkScoped);
      yield* Effect.promise(() => holding.promise);
      const arrived = Promise.withResolvers<void>();
      calls.received = (timeoutMs) => {
        if (timeoutMs === 1_000) arrived.resolve();
      };
      const queued = yield* wait(1_000).pipe(Effect.result, Effect.forkScoped);
      yield* Effect.promise(() => arrived.promise);
      calls.received = undefined;
      clock = queuedMs;
      release.resolve();
      yield* Fiber.join(first);
      const result = yield* Fiber.join(queued);
      if (queuedMs < 1_000) {
        expect(result._tag).toBe("Success");
        expect(timeouts).toHaveLength(2);
        expect(timeouts[1]).toBeLessThanOrEqual(1_000 - queuedMs);
      } else {
        // A timeout would read as an unmet condition; this wait never looked.
        expect(result._tag === "Failure" && result.failure._tag).toBe(
          "PreviewAutomationExecutionError",
        );
        expect(timeouts).toHaveLength(1);
      }
    }),
  ).pipe(Effect.provide(layer)),
);
