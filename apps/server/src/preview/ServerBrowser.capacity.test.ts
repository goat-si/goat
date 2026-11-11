import { historyMemoryLayer } from "./BrowserHistoryAssertions.testkit.ts";
import * as NodeEvents from "node:events";
import * as NodeVM from "node:vm";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  EnvironmentId,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationStatus,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type { BrowserContext, Page } from "playwright-core";
import { beforeEach, expect, vi } from "vite-plus/test";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import * as DesktopChannel from "./DesktopBrowserChannel.ts";
import * as Manager from "./Manager.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as PreviewAgentActivity from "./PreviewAgentActivity.ts";
import * as ServerBrowser from "./ServerBrowser.ts";
import * as PreviewBrowser from "./PreviewBrowser.ts";
import { unusedPreviewBrowser } from "./PreviewBrowser.testkit.ts";
import { makeFrame, makeSession, mockCopy } from "./ServerBrowserTestFixtures.ts";

vi.mock("./ServerBrowserContexts.ts", () => ({
  presentAsChrome: async () => {},
  ServerBrowserContexts: class {
    private readonly onClose: ((context: BrowserContext) => void) | undefined;
    constructor(options: { onContextClose?: (context: BrowserContext) => void }) {
      this.onClose = options.onContextClose;
    }
    async contextFor(profileId: string, isolationKey?: string) {
      contextRequests.push({ profileId, isolated: isolationKey !== undefined });
      if (contextFailure) throw contextFailure;
      await contextGate?.promise;
      const context = makeContext(this.onClose);
      contexts.push(context);
      return context as unknown as BrowserContext;
    }
    storePin = async () => undefined;
    pinStore = async (_profileId: string, store: string) => store;
    withProfile = <A>(_profileId: string, run: () => Promise<A>) => run();
    async scratchPage() {
      return makeEncoderPage() as unknown as Page;
    }
    async connectDesktopPage(endpoint: string) {
      const context = makeContext(undefined, desktopPageUrl);
      context.page.viewportSize.mockReturnValue(null);
      desktopConnections.push({ endpoint, context });
      return { browser: { close: async () => {} }, page: context.page as unknown as Page };
    }
    async close() {
      for (const context of contexts) await context.close();
    }
  },
}));

function fileChooserElement(accept: string) {
  return {
    getAttribute: async () => accept,
    evaluate: (probe: (element: { ownerDocument: unknown }) => boolean) =>
      Promise.resolve(
        probe({
          ownerDocument: (globalThis as typeof globalThis & { document?: unknown }).document,
        }),
      ),
  };
}

function makeContext(onClose?: (context: BrowserContext) => void, initialUrl = "about:blank") {
  const events = new NodeEvents.EventEmitter();
  const nativeFileChooser = vi.fn();
  const setChooserFiles = vi.fn(async (_files: unknown) => {});
  const sessions: ReturnType<typeof makeSession>[] = [];
  let url = initialUrl;
  let viewport: ReturnType<Page["viewportSize"]> = { width: 1280, height: 800 };
  const cssViewport = { width: 1920, height: 1080 };
  let closed = false;
  let contextClosed = false;
  const page = {
    on: (name: string, callback: (...args: unknown[]) => void) => events.on(name, callback),
    once: (name: string, callback: (...args: unknown[]) => void) => events.once(name, callback),
    off: (name: string, callback: (...args: unknown[]) => void) => events.off(name, callback),
    emit: (name: string, ...args: unknown[]) => events.emit(name, ...args),
    emitConsole: (text: string, level = "log", args: unknown[] = [text]) =>
      events.emit("console", { type: () => level, text: () => text, args: () => args }),
    nativeFileChooser,
    setChooserFiles,
    openFileChooser: () => {
      if (
        !events.emit("filechooser", {
          isMultiple: () => false,
          element: () => fileChooserElement(".csv"),
          setFiles: setChooserFiles,
        })
      ) {
        nativeFileChooser();
      }
    },
    emitAsync: (name: string, ...args: unknown[]) =>
      Promise.all(events.listeners(name).map((listener) => listener(...args))),
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
    context: () => context,
    mainFrame: () => page,
    frames: () => [page],
    url: () => url,
    title: vi.fn(async () => "test page"),
    viewportSize: vi.fn(() => viewport),
    setViewportSize: vi.fn(async (size: typeof viewport) => {
      viewport = size;
    }),
    goto: vi.fn(async (next: string) => {
      url = next;
      events.emit("load");
      const pending = initialNavigation;
      initialNavigation = null;
      await pending?.();
    }),
    goBack: vi.fn(async () => {}),
    goForward: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
    emulateMedia: vi.fn(async () => {}),
    waitForLoadState: vi.fn(async () => {}),
    waitForNavigation: vi.fn(async () => null),
    evaluate: vi.fn(async () => ({
      url,
      title: "test page",
      loading: false,
      visibleText: "delete",
      interactiveElements: [],
    })),
    ariaSnapshot: vi.fn(async () => '- button "delete" [ref=e1]'),
    locator: vi.fn(() => {
      throw new Error("Unexpected locator action");
    }),
    mouse: { click: async () => {} },
    isClosed: () => closed,
    close: vi.fn(async () => {
      if (!closed) {
        closed = true;
        events.emit("close");
      }
    }),
  };
  const context = {
    page,
    sessions,
    on: () => context,
    cssViewport,
    newPage: async () => page as unknown as Page,
    grantPermissions: vi.fn(async () => {}),
    cookies: async () => [],
    newCDPSession: async (target: unknown) => {
      const session = makeSession(
        target === page ? undefined : (target as ReturnType<typeof makeFrame>),
        () => desktopSizeAnswer?.() ?? Promise.resolve({ result: { value: { ...cssViewport } } }),
      );
      sessions.push(session);
      return session;
    },
    close: vi.fn(async () => {
      if (contextClosed) return;
      contextClosed = true;
      await page.close();
      onClose?.(context as unknown as BrowserContext);
    }),
  };
  return context;
}

function makeEncoderPage() {
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage() {}, fillRect() {} }),
    captureStream: (frameRate?: number) => ({ frameRate, getTracks: () => [] }),
  };
  class FakeMediaRecorder {
    static isTypeSupported = (type: string) => type === "video/webm";
    onstart: (() => void) | null = null;
    constructor(stream: { frameRate?: number }, options: { videoBitsPerSecond: number }) {
      encoderStreams.push({
        frameRate: stream.frameRate,
        bitsPerSecond: options.videoBitsPerSecond,
      });
    }
    start() {
      this.onstart?.();
    }
  }
  const sandbox: Record<string, unknown> = {
    document: { createElement: () => canvas },
    Path2D: function Path2D() {},
    MediaRecorder: FakeMediaRecorder,
    createImageBitmap: async () => ({ width: 1280, height: 800, close() {} }),
    atob,
    Blob,
    performance,
  };
  sandbox.window = sandbox;
  const context = NodeVM.createContext(sandbox);
  return {
    ...makeContext().page,
    evaluate: vi.fn(async (script: string | ((arg: unknown) => unknown), arg?: unknown) =>
      typeof script === "string"
        ? NodeVM.runInContext(script, context)
        : NodeVM.runInContext(`(${script.toString()})`, context)(arg),
    ),
  };
}

const contexts: ReturnType<typeof makeContext>[] = [];
const encoderStreams: Array<{ frameRate: number | undefined; bitsPerSecond: number }> = [];
const contextRequests: Array<{ profileId: string; isolated: boolean }> = [];
let contextGate: PromiseWithResolvers<void> | null = null;
let contextFailure: Error | null = null;
let initialNavigation: (() => Promise<void>) | null = null;
let desktopRendersNext = false;
let desktopPageUrl = "about:blank";
/** Replaces the answer to the desktop page's size reads. */
let desktopSizeAnswer: (() => Promise<Record<string, unknown>>) | null = null;
const desktopDetaches = new NodeEvents.EventEmitter();
let desktopDetachReady = Promise.withResolvers<void>();
let desktopAttachReady = Promise.withResolvers<void>();
let desktopDetachDrained = Promise.withResolvers<void>();
let desktopAttachDrained = Promise.withResolvers<void>();
let desktopAttachListeners = 0;
let desktopAttachBarriers = 0;
let heldDetach: PromiseWithResolvers<void> | null = null;
let enteredDetach = Promise.withResolvers<void>();
let desktopReleased = Promise.withResolvers<void>();
const desktopTabs = new Set<string>();
const desktopEndpoints = new Map<string, object>();
const desktopRenders = (tabId: string) => {
  if (desktopRendersNext) {
    desktopRendersNext = false;
    desktopTabs.add(tabId);
  }
  return desktopTabs.has(tabId);
};
const shownDesktopTabs = new Set<string>();
const releasedDesktopTabs: Array<string> = [];
const desktopTurns = new NodeEvents.EventEmitter();
const desktopConnections: Array<{ endpoint: string; context: ReturnType<typeof makeContext> }> = [];
const testThread = {
  threadId: ThreadId.make("browser-test-thread"),
  providerSessionId: "agent-a",
  providerInstanceId: ProviderInstanceId.make("codex"),
};
const scope = {
  environmentId: EnvironmentId.make("browser-test-environment"),
  thread: testThread,
  client: undefined,
  requestNamespace: "browser-test",
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};
const asSession = (providerSessionId: string) => ({
  ...scope,
  thread: { ...testThread, providerSessionId },
});
const dependencies = Layer.mergeAll(
  ServerSettings.layerTest(),
  historyMemoryLayer,
  Broker.layer,
  Manager.layer,
  Layer.succeed(ServerEnvironment.ServerEnvironment, {
    getEnvironmentId: Effect.succeed(scope.environmentId),
    getDescriptor: Effect.die("unused descriptor"),
  }),
  Layer.succeed(PreviewBrowser.PreviewBrowser, unusedPreviewBrowser),
  Layer.succeed(DesktopChannel.DesktopBrowserChannel, {
    available: true,
    awaitAttached: (key) => Effect.sync(() => desktopRenders(key.tabId)),
    detached: Stream.callback<{ threadId: string; tabId: string }>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const onDetach = (key: { threadId: string; tabId: string }) => {
            desktopEndpoints.delete(key.tabId);
            Queue.offerUnsafe(queue, key);
          };
          desktopDetaches.on("detach", onDetach);
          desktopDetachReady.resolve();
          return onDetach;
        }),
        (onDetach) => Effect.sync(() => desktopDetaches.off("detach", onDetach)),
      ),
    ).pipe(
      Stream.tap((key) =>
        key.tabId !== "" && heldDetach !== null
          ? Effect.sync(() => enteredDetach.resolve()).pipe(
              Effect.andThen(Effect.promise(() => heldDetach!.promise)),
            )
          : Effect.void,
      ),
      Stream.tap((key) =>
        Effect.sync(() => {
          if (key.tabId === "") desktopDetachDrained.resolve();
        }),
      ),
      Stream.filter((key) => key.tabId !== ""),
    ),
    attached: Stream.callback<{ threadId: string; tabId: string }>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const onAttach = (key: { threadId: string; tabId: string }) =>
            Queue.offerUnsafe(queue, key);
          desktopDetaches.on("attach", onAttach);
          if (++desktopAttachListeners === 2) desktopAttachReady.resolve();
          return onAttach;
        }),
        (onAttach) => Effect.sync(() => desktopDetaches.off("attach", onAttach)),
      ),
    ).pipe(
      Stream.tap((key) =>
        Effect.sync(() => {
          if (key.tabId === "" && ++desktopAttachBarriers === 2) desktopAttachDrained.resolve();
        }),
      ),
      Stream.filter((key) => key.tabId !== ""),
    ),
    isAttached: (key) => Effect.sync(() => desktopRenders(key.tabId)),
    isShown: (key) => shownDesktopTabs.has(key.tabId),
    endpoint: (key) => {
      const token = {};
      return Effect.acquireRelease(
        Effect.sync(() => {
          desktopEndpoints.set(key.tabId, token);
          return `ws://desktop/${key.tabId}`;
        }),
        () =>
          Effect.sync(() => {
            if (desktopEndpoints.get(key.tabId) !== token) return;
            desktopEndpoints.delete(key.tabId);
            releasedDesktopTabs.push(key.tabId);
            desktopDetaches.emit("release", key.tabId);
            desktopReleased.resolve();
          }),
      );
    },
    pointer: () => Effect.void,
    turn: (threadId, active) => Effect.sync(() => desktopTurns.emit("turn", threadId, active)),
  }),
  PreviewAgentActivity.layer,
  Layer.mock(SecretRequests.SecretRequests)({}),
).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "goat-server-browser-" })),
  Layer.provideMerge(NodeServices.layer),
);
const layer = ServerBrowser.layer.pipe(Layer.provideMerge(dependencies));
beforeEach(() => {
  contexts.length = 0;
  encoderStreams.length = 0;
  contextRequests.length = 0;
  contextGate = null;
  contextFailure = null;
  initialNavigation = null;
  mockCopy.page = "";
  mockCopy.key = "";
  mockCopy.focusedFrame = null;
  desktopTabs.clear();
  desktopEndpoints.clear();
  shownDesktopTabs.clear();
  desktopRendersNext = false;
  desktopPageUrl = "about:blank";
  desktopSizeAnswer = null;
  desktopDetachReady = Promise.withResolvers<void>();
  desktopAttachReady = Promise.withResolvers<void>();
  desktopDetachDrained = Promise.withResolvers<void>();
  desktopAttachDrained = Promise.withResolvers<void>();
  desktopAttachListeners = 0;
  desktopAttachBarriers = 0;
  heldDetach = null;
  enteredDetach = Promise.withResolvers<void>();
  desktopReleased = Promise.withResolvers<void>();
  releasedDesktopTabs.length = 0;
  desktopConnections.length = 0;
});
it.effect.each([false, true])(
  "a desktop reload keeps an agent-owned background tab for reattachment (attach first: %s)",
  (attachFirst) =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* Broker.PreviewAutomationBroker;
        const manager = yield* Manager.PreviewManager;
        const browser = yield* ServerBrowser.ServerBrowser;
        yield* Effect.promise(() =>
          Promise.all([desktopDetachReady.promise, desktopAttachReady.promise]),
        );
        const reportProfiles = yield* browser.profileReporter;
        yield* reportProfiles({
          profiles: [{ id: "profile-work", name: "Work", kind: "persistent" }],
          defaultProfileId: "profile-work",
        });
        desktopRendersNext = true;
        const opened = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          operation: "open",
          input: { reuseExistingTab: false, show: false, profileId: "profile-work" },
        });
        const tabId = opened.tabId!;
        const before = yield* manager.list({ threadId: scope.thread.threadId });
        const owner = before.sessions.find((session) => session.tabId === tabId)?.automationOwner;
        expect(owner).toBeDefined();
        const key = { threadId: scope.thread.threadId, tabId };
        if (attachFirst) heldDetach = Promise.withResolvers<void>();
        desktopTabs.delete(tabId);
        desktopDetaches.emit("detach", key);
        desktopDetaches.emit("detach", { ...key, tabId: "" });
        if (attachFirst) yield* Effect.promise(() => enteredDetach.promise);
        else yield* Effect.promise(() => desktopDetachDrained.promise);
        desktopTabs.add(tabId);
        desktopDetaches.emit("attach", key);
        desktopDetaches.emit("attach", { ...key, tabId: "" });
        yield* Effect.promise(() => desktopAttachDrained.promise);
        if (attachFirst) {
          heldDetach?.resolve();
          yield* Effect.promise(() => desktopDetachDrained.promise);
        }
        const { sessions } = yield* manager.list({ threadId: scope.thread.threadId });
        expect(sessions.find((session) => session.tabId === tabId)).toMatchObject({
          automationOwner: owner,
        });
        expect(releasedDesktopTabs).not.toContain(tabId);
        expect(desktopConnections).toHaveLength(2);
        const status = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          tabId: PreviewTabId.make(tabId),
          operation: "status",
          input: {},
        });
        expect(status.tabs).toContainEqual(expect.objectContaining({ tabId, ownedByCaller: true }));
      }),
    ).pipe(Effect.provide(layer)),
);
it.live("a full server takes back the slot of the longest idle agent tab nobody views", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* Broker.PreviewAutomationBroker;
      const manager = yield* Manager.PreviewManager;
      const browser = yield* ServerBrowser.ServerBrowser;
      yield* Effect.yieldNow;
      const reportProfiles = yield* browser.profileReporter;
      yield* reportProfiles({
        profiles: [{ id: "profile-work", name: "Work", kind: "persistent" }],
        defaultProfileId: "profile-work",
      });
      const now = vi.spyOn(Date, "now").mockReturnValue(0);
      yield* Effect.addFinalizer(() => Effect.sync(() => now.mockRestore()));
      const open = (providerSessionId: string) => {
        desktopRendersNext = true;
        return broker.invoke<PreviewAutomationStatus>({
          scope: asSession(providerSessionId),
          operation: "open",
          input: { reuseExistingTab: false, show: false, profileId: "profile-work" },
        });
      };
      const opened: Array<string> = [];
      for (let index = 0; index < 32; index++) {
        now.mockReturnValue(index);
        opened.push((yield* open(`agent-${Math.floor(index / 8)}`)).tabId!);
      }

      now.mockReturnValue(100);
      yield* broker.invoke<PreviewAutomationStatus>({
        scope: asSession("agent-observer"),
        operation: "status",
        tabId: PreviewTabId.make(opened[0]!),
        input: {},
      });

      // Inside the idle window every desktop tab keeps its slot.
      now.mockReturnValue(29 * 60 * 1000);
      expect(yield* open("agent-new").pipe(Effect.flip)).toMatchObject({ reason: "tabLimit" });
      expect(releasedDesktopTabs).toEqual([]);

      now.mockReturnValue(31 * 60 * 1000);
      // A session at its own limit couldn't use a freed slot, so nothing closes for it.
      expect(yield* open("agent-3").pipe(Effect.flip)).toMatchObject({ reason: "tabLimit" });
      expect(releasedDesktopTabs).toEqual([]);
      // Tabs a desktop window shows keep their slots however long they sit idle.
      for (const tabId of opened) shownDesktopTabs.add(tabId);
      expect(yield* open("agent-new").pipe(Effect.flip)).toMatchObject({ reason: "tabLimit" });
      expect(releasedDesktopTabs).toEqual([]);
      shownDesktopTabs.clear();
      shownDesktopTabs.add(opened[1]!);
      const events = yield* manager.subscribeEvents;
      const releases = yield* Queue.unbounded<string>();
      const recordRelease = (tabId: string) => Queue.offerUnsafe(releases, tabId);
      desktopDetaches.on("release", recordRelease);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => desktopDetaches.off("release", recordRelease)),
      );
      const fresh = yield* open("agent-new");
      expect(fresh.tabId).toBeDefined();
      expect(yield* Queue.take(releases)).toBe(opened[2]);
      yield* Stream.fromSubscription(events).pipe(
        Stream.filter((event) => event.type === "closed" && event.tabId === opened[2]),
        Stream.runHead,
      );
      expect(releasedDesktopTabs).toEqual([opened[2]]);
      const { sessions } = yield* manager.list({ threadId: scope.thread.threadId });
      expect(sessions.map((session) => session.tabId).toSorted()).toEqual(
        [...opened.filter((tabId) => tabId !== opened[2]), fresh.tabId!].toSorted(),
      );
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("the tab the desktop shows is visible and picked for agents without a tab", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* Broker.PreviewAutomationBroker;
      const manager = yield* Manager.PreviewManager;
      yield* ServerBrowser.ServerBrowser;
      yield* Effect.yieldNow;
      const openDesktopTab = Effect.fn("openDesktopTab")(function* (url: string) {
        desktopRendersNext = true;
        const opened = yield* manager.open({
          threadId: scope.thread.threadId,
          url,
          runtime: "server",
        });
        const tabId = PreviewTabId.make(opened.tabId);
        yield* broker.invoke({ scope, tabId, operation: "status", input: {} });
        return tabId;
      });
      const recentTab = yield* openDesktopTab("http://localhost:5173/recent");
      const shownTab = yield* openDesktopTab("http://localhost:5173/shown");
      // Opened first and used last, so recency or insertion order alone picks it.
      yield* broker.invoke({ scope, tabId: recentTab, operation: "status", input: {} });

      shownDesktopTabs.add(shownTab);
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope: asSession("agent-b"),
        operation: "status",
        input: {},
      });
      expect(status).toMatchObject({
        tabId: shownTab,
        visible: true,
        tabs: [
          expect.objectContaining({ tabId: recentTab, visible: false }),
          expect.objectContaining({ tabId: shownTab, visible: true }),
        ],
      });
    }),
  ).pipe(Effect.provide(layer)),
);
