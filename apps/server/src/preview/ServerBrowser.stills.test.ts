import * as NodeFS from "node:fs";
import * as NodeEvents from "node:events";
import * as NodeVM from "node:vm";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type { BrowserContext, Page } from "playwright-core";
import { expect, vi } from "vite-plus/test";
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
import { historyMemoryLayer } from "./BrowserHistoryAssertions.testkit.ts";
import { makeFrame, makeSession } from "./ServerBrowserTestFixtures.ts";

const originalJpeg = NodeFS.readFileSync(
  new URL("./fixtures/still-large.jpg", import.meta.url),
).toString("base64");
const smallJpeg = NodeFS.readFileSync(
  new URL("./fixtures/still-small.jpg", import.meta.url),
).toString("base64");
let failure: "transport" | "exception" | null = null;
let fit = false;
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
      const context = makeContext();
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

function makeContext(onClose?: (context: BrowserContext) => void) {
  const events = new NodeEvents.EventEmitter();
  const nativeFileChooser = vi.fn();
  const setChooserFiles = vi.fn(async (_files: unknown) => {});
  const sessions: ReturnType<typeof makeSession>[] = [];
  let url = "about:blank";
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
      const originalSend = session.send.getMockImplementation()!;
      session.send.mockImplementation(async (method, input) => {
        if (method === "Page.captureScreenshot" && (input as { format: string }).format === "jpeg")
          return { data: originalJpeg };
        if (method === "Runtime.callFunctionOn") {
          if (failure === "transport") throw new Error("resize failed");
          if (failure === "exception")
            return { result: {}, exceptionDetails: { text: "resize failed" } };
          return { result: { value: fit ? null : smallJpeg } };
        }
        return originalSend(method, input);
      });
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
/** Replaces the answer to the desktop page's size reads. */
let desktopSizeAnswer: (() => Promise<Record<string, unknown>>) | null = null;
const desktopDetaches = new NodeEvents.EventEmitter();
let desktopDetachReady = Promise.withResolvers<void>();
let desktopReleased = Promise.withResolvers<void>();
const desktopTabs = new Set<string>();
const desktopRenders = (tabId: string) => {
  if (desktopRendersNext) {
    desktopRendersNext = false;
    desktopTabs.add(tabId);
  }
  return desktopTabs.has(tabId);
};
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
          const onDetach = (key: { threadId: string; tabId: string }) =>
            Queue.offerUnsafe(queue, key);
          desktopDetaches.on("detach", onDetach);
          desktopDetachReady.resolve();
          return onDetach;
        }),
        (onDetach) => Effect.sync(() => desktopDetaches.off("detach", onDetach)),
      ),
    ),
    attached: Stream.callback<{ threadId: string; tabId: string }>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const onAttach = (key: { threadId: string; tabId: string }) =>
            Queue.offerUnsafe(queue, key);
          desktopDetaches.on("attach", onAttach);
          return onAttach;
        }),
        (onAttach) => Effect.sync(() => desktopDetaches.off("attach", onAttach)),
      ),
    ),
    isAttached: (key) => Effect.sync(() => desktopRenders(key.tabId)),
    endpoint: (key) =>
      Effect.acquireRelease(Effect.succeed(`ws://desktop/${key.tabId}`), () =>
        Effect.sync(() => {
          releasedDesktopTabs.push(key.tabId);
          desktopReleased.resolve();
        }),
      ),
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
const ready = Effect.gen(function* () {
  const browser = yield* ServerBrowser.ServerBrowser;
  const manager = yield* Manager.PreviewManager;
  const { tabId } = yield* manager.open({ threadId: scope.thread.threadId, runtime: "server" });
  return { browser, tabId };
});
const viewerInput = (tabId: string, canOperate: boolean) => ({
  threadId: scope.thread.threadId,
  tabId,
  canOperate,
  maxWidth: 1280,
  maxHeight: 800,
  quality: 70,
});

it.effect("bounds the first idle still for a passive viewer", () =>
  Effect.scoped(
    Effect.gen(function* () {
      failure = null;
      fit = false;
      const { browser, tabId } = yield* ready;
      const viewer = yield* browser.attachViewer({
        ...viewerInput(tabId, false),
        maxWidth: 480,
        maxHeight: 480,
      });
      const outputs = yield* Queue.takeAll(viewer.output);
      const frames = outputs.filter((item) => item._tag === "frame");
      expect(frames).toHaveLength(1);
      expect(frames[0]!.data).toEqual(Buffer.from(smallJpeg, "base64"));
    }),
  ).pipe(Effect.provide(layer)),
);
it.effect("keeps the original still for a full-size viewer", () =>
  Effect.scoped(
    Effect.gen(function* () {
      failure = null;
      fit = true;
      const { browser, tabId } = yield* ready;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, false));
      const outputs = yield* Queue.takeAll(viewer.output);
      expect(outputs.filter((item) => item._tag === "frame").map((item) => item.data)).toEqual([
        Buffer.from(originalJpeg, "base64"),
      ]);
    }),
  ).pipe(Effect.provide(layer)),
);
it.effect.each(["transport", "exception"] as const)(
  "skips a failed resize (%s) and streams later frames",
  (mode) =>
    Effect.scoped(
      Effect.gen(function* () {
        failure = mode;
        fit = false;
        const { browser, tabId } = yield* ready;
        const viewer = yield* browser.attachViewer({
          ...viewerInput(tabId, false),
          maxWidth: 480,
          maxHeight: 480,
        });
        const outputs = yield* Queue.takeAll(viewer.output);
        expect(outputs.filter((item) => item._tag === "frame")).toHaveLength(0);
        const session = contexts.at(-1)!.sessions.at(-1)!;
        session.emit("Page.screencastFrame", {
          data: Buffer.from("later").toString("base64"),
          sessionId: 1,
        });
        const later = yield* Queue.takeAll(viewer.output);
        expect(later).toContainEqual(
          expect.objectContaining({ _tag: "frame", data: Buffer.from("later") }),
        );
      }),
    ).pipe(Effect.provide(layer)),
);
