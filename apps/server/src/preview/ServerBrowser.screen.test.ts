import * as NodeEvents from "node:events";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  EnvironmentId,
  PreviewTabId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type AgentCursorSnapshot,
  type PreviewAutomationStatus,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
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
      events.emit("framenavigated", page);
      events.emit("load");
    }),
    keyboard: { press: vi.fn(async (_key: string) => {}) },
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
    locator: vi.fn((): unknown => {
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
    runId: RunId.make("browser-run"),
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
      const retry = yield* broker
        .invoke({ scope, tabId, operation: "navigate", input: { url: "https://safe.example/" } })
        .pipe(Effect.result);
      expect(retry._tag).toBe("Failure");
      if (retry._tag === "Failure")
        expect(retry.failure).toMatchObject({ reason: "blocked_url", dispatched: false });
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

it.effect("keeps a tab blocked after the person leaves the blocked host in the same turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({ blockedBrowserHosts: ["example.com"] });
      const page = contexts.at(-1)!.page;
      yield* Effect.promise(() => page.goto("https://example.com/"));
      const input = { scope, tabId, operation: "click" as const, input: { locator: "button" } };
      const first = yield* broker.invoke(input).pipe(Effect.result);
      expect(first._tag).toBe("Failure");
      if (first._tag === "Failure") expect(first.failure).toMatchObject({ reason: "blocked_url" });
      yield* Effect.promise(() => page.goto("https://safe.example/"));
      const second = yield* broker.invoke(input).pipe(Effect.result);
      expect(second._tag).toBe("Failure");
      if (second._tag === "Failure")
        expect(second.failure).toMatchObject({ reason: "blocked_url", dispatched: false });
      expect(page.locator).not.toHaveBeenCalled();
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("remembers a blocked host the person left before the next agent input", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({ blockedBrowserHosts: ["example.com"] });
      const page = contexts.at(-1)!.page;
      yield* Effect.promise(() => page.goto("https://example.com/"));
      yield* Effect.promise(() => page.goto("https://safe.example/"));
      const result = yield* broker
        .invoke({ scope, tabId, operation: "click", input: { locator: "button" } })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({ reason: "blocked_url", dispatched: false });
      expect(page.locator).not.toHaveBeenCalled();
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("refuses the next input after navigation during an input", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({ blockedBrowserHosts: ["example.com"] });
      const page = contexts.at(-1)!.page;
      page.keyboard.press.mockImplementationOnce(async () => {
        await page.goto("https://example.com/");
      });
      const input = { scope, tabId, operation: "press" as const, input: { key: "Enter" } };
      expect((yield* broker.invoke(input).pipe(Effect.result))._tag).toBe("Success");
      yield* Effect.promise(() => page.goto("https://safe.example/"));
      const next = yield* broker.invoke(input).pipe(Effect.result);
      expect(next._tag).toBe("Failure");
      if (next._tag === "Failure")
        expect(next.failure).toMatchObject({ reason: "blocked_url", dispatched: false });
      expect(page.keyboard.press).toHaveBeenCalledTimes(1);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("refuses input at the dispatch gate after a blocked visit while the target waits", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({ blockedBrowserHosts: ["example.com"] });
      const page = contexts.at(-1)!.page;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const context = yield* Effect.context<never>();
      const run = Effect.runPromiseWith(context);
      const handle = {
        ownerFrame: async () => null,
        dispose: async () => {},
        waitForElementState: async () => {},
      };
      const hover = vi.fn(async () => {});
      const locator = {
        first: () => locator,
        elementHandle: async () => {
          await run(Deferred.succeed(entered, undefined));
          await run(Deferred.await(release));
          return handle;
        },
        boundingBox: async () => ({ x: 1, y: 1, width: 20, height: 20 }),
        hover,
      };
      page.locator.mockImplementation(() => locator);
      const fiber = yield* broker
        .invoke({ scope, tabId, operation: "hover", input: { locator: "button" } })
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(entered);
      yield* Effect.promise(() => page.goto("https://example.com/"));
      yield* Effect.promise(() => page.goto("https://safe.example/"));
      yield* Deferred.succeed(release, undefined);
      const result = yield* Fiber.join(fiber);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({ reason: "blocked_url", dispatched: false });
      expect(hover).not.toHaveBeenCalled();
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("refuses claim on a blocked tab and permits it in a later run after leaving", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({ blockedBrowserHosts: ["example.com"] });
      const page = contexts.at(-1)!.page;
      yield* Effect.promise(() => page.goto("https://example.com/"));
      const claim = { scope, tabId, operation: "claim" as const, input: {} };
      const blocked = yield* broker.invoke(claim).pipe(Effect.result);
      expect(blocked._tag).toBe("Failure");
      if (blocked._tag === "Failure")
        expect(blocked.failure).toMatchObject({ reason: "blocked_url", dispatched: false });
      yield* Effect.promise(() => page.goto("https://safe.example/"));
      const sameRun = yield* broker.invoke(claim).pipe(Effect.result);
      expect(sameRun._tag).toBe("Failure");
      if (sameRun._tag === "Failure")
        expect(sameRun.failure).toMatchObject({ reason: "blocked_url" });
      expect((yield* broker.invoke({ ...claim, runId: "next-run" }).pipe(Effect.result))._tag).toBe(
        "Success",
      );
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("records a person's blocked visit in the active run before its first browser call", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({ blockedBrowserHosts: ["example.com"] });
      const activity = yield* PreviewAgentActivity.PreviewAgentActivity;
      const end = yield* activity.begin(scope.thread.threadId, "next-run");
      const page = contexts.at(-1)!.page;
      yield* Effect.promise(() => page.goto("https://example.com/"));
      yield* Effect.promise(() => page.goto("https://safe.example/"));
      const result = yield* broker
        .invoke({
          scope,
          tabId,
          runId: "next-run",
          operation: "claim",
          input: {},
        })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({ reason: "blocked_url" });
      yield* end;
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("refuses reuse of a tab currently at a blocked host", () =>
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
          operation: "open",
          input: { reuseExistingTab: true, show: false },
        })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({ reason: "blocked_url", dispatched: false });
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
