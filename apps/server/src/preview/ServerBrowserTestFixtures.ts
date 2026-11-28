import type { BrowserContext, Page } from "playwright-core";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationStatus,
  type PreviewTabId,
} from "@goat/contracts";
import * as Queue from "effect/Queue";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { expect } from "@effect/vitest";
import type * as Broker from "../mcp/PreviewAutomationBroker.ts";
import type * as Manager from "./Manager.ts";
import type * as ServerBrowser from "./ServerBrowser.ts";
// @effect-diagnostics nodeBuiltinImport:off - a mocked CDP session for ServerBrowser tests; no Effect runtime.
import * as NodeEvents from "node:events";
import { vi } from "vite-plus/test";

type MockFrame = ReturnType<typeof makeFrame>;

/** What the next copy shortcut copies: the page's selection, or the focused frame's. */
export const mockCopy: { page: string; key: string; focusedFrame: MockFrame | null } = {
  page: "",
  key: "",
  focusedFrame: null,
};

export function makeFrame() {
  const frame = {
    copy: "",
    detached: false,
    isDetached: () => frame.detached,
    recording: Promise.withResolvers<void>(),
  };
  return frame;
}

/** A ref-click locator: a 10px box at the origin whose probe finds it on top at its centre. */
export function refClickTarget() {
  const box = async () => ({ x: 0, y: 0, width: 10, height: 10 });
  const evaluate = async () => ({
    rects: [{ x: 0, y: 0, width: 10, height: 10 }],
    origin: { x: 0, y: 0 },
    border: { x: 0, y: 0 },
    inside: true,
  });
  const element = { boundingBox: box, waitForElementState: box, dispose: box, evaluate };
  const handle = { ...element, ownerFrame: async () => null };
  return {
    scrollIntoViewIfNeeded: box,
    boundingBox: box,
    click: vi.fn(async (_options?: unknown) => {}),
    elementHandle: async () => handle,
    count: async () => 1,
  };
}

const PNG_HEADER = (() => {
  const header = Buffer.alloc(24);
  header.write("IHDR", 12);
  header.writeUInt32BE(1280, 16);
  header.writeUInt32BE(800, 20);
  return header.toString("base64");
})();

export function makeSession(
  frame?: MockFrame,
  viewportAnswer?: () => Promise<Record<string, unknown>>,
) {
  const events = new NodeEvents.EventEmitter();
  return {
    on: vi.fn((name: string, listener: (...args: unknown[]) => void) => events.on(name, listener)),
    emit: (name: string, ...args: unknown[]) => events.emit(name, ...args),
    emitAsync: (name: string, ...args: unknown[]) =>
      Promise.all(events.listeners(name).map((listener) => listener(...args))),
    detach: vi.fn(async () => {}),
    send: vi.fn(async (method: string, input?: unknown): Promise<Record<string, unknown>> => {
      if (method === "Page.getNavigationHistory") return { currentIndex: 0, entries: [{}] };
      if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { pageX: 0, pageY: 0 } };
      if (method === "Page.captureScreenshot") {
        // A snapshot sizes its screenshot from the PNG header; viewers get JPEG frames as-is.
        return { data: (input as { format: string }).format === "png" ? PNG_HEADER : "ZnJhbWU=" };
      }
      // Snapshots shrink their screenshot in the page; the header stands in for the result.
      if (method === "Runtime.callFunctionOn")
        return {
          result: {
            value: (input as { arguments?: unknown[] }).arguments?.length === 4 ? null : PNG_HEADER,
          },
        };
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      // Snapshots read password fields from their own isolated world in each frame.
      if (method === "Page.createIsolatedWorld") {
        return {
          executionContextId:
            (input as { worldName?: string }).worldName === "goat-preview-viewport"
              ? 9
              : (input as { worldName?: string }).worldName === "goat-preview"
                ? 1
                : (input as { worldName?: string }).worldName === "goat-preview-metrics"
                  ? 8
                  : 7,
        };
      }
      if (method === "Runtime.evaluate" && (input as { contextId?: number }).contextId === 9) {
        return viewportAnswer?.() ?? { result: { value: { width: 1280, height: 800 } } };
      }
      if (method === "Runtime.evaluate" && (input as { contextId?: number }).contextId === 1) {
        return { result: { value: [] } };
      }
      if (method === "Runtime.evaluate" && (input as { contextId?: number }).contextId === 8) {
        return { result: { value: { ratio: 1, width: 1280, height: 800 } } };
      }
      if (method === "Page.addScriptToEvaluateOnNewDocument") frame?.recording.resolve();
      if (
        method === "Input.dispatchKeyEvent" &&
        ["copy", "cut"].includes((input as { commands?: string[] }).commands?.[0] ?? "")
      ) {
        if (mockCopy.focusedFrame) mockCopy.focusedFrame.copy = mockCopy.key;
        else mockCopy.page = mockCopy.key;
      }
      if (method === "Runtime.evaluate" && (input as { contextId?: number }).contextId === 7) {
        const value = frame ? frame.copy : mockCopy.page;
        if (frame) frame.copy = "";
        else mockCopy.page = "";
        return { result: { value } };
      }
      return { result: { value: "evaluated" } };
    }),
  };
}

export function fileChooserElement(accept: string) {
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

// Fills the queue immediately before the caller drives the stalled viewer.
// @effect-diagnostics effectFnOpportunity:off
export const stallViewer = (viewer: ServerBrowser.ServerBrowserViewer) => {
  const output = viewer.output as unknown as Queue.Queue<ServerBrowser.ServerBrowserViewerOutput>;
  const acked = Promise.withResolvers<void>();
  let unacked = 0;
  const ack = Effect.sync(() => {
    if (--unacked === 0) acked.resolve();
  });
  while (Queue.offerUnsafe(output, { _tag: "frame", data: Buffer.alloc(0), ack })) unacked++;
  return Effect.promise(() => acked.promise);
};

export const viewportSizes = (items: ReadonlyArray<ServerBrowser.ServerBrowserViewerOutput>) =>
  items.flatMap((item) => (item._tag === "viewport" ? [`${item.width}x${item.height}`] : []));

const testThread = {
  threadId: ThreadId.make("browser-test-thread"),
  providerSessionId: "agent-a",
  providerInstanceId: ProviderInstanceId.make("codex"),
};
export const scope = {
  environmentId: EnvironmentId.make("browser-test-environment"),
  thread: testThread,
  client: undefined,
  requestNamespace: "browser-test",
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};
export const asSession = (providerSessionId: string) => ({
  ...scope,
  thread: { ...testThread, providerSessionId },
});

export function makePageContext(
  hooks: {
    readonly setupFailure: () => Error | null;
    readonly initialNavigation: () => Promise<void> | undefined;
    readonly desktopSize: () => Promise<Record<string, unknown>> | undefined;
  },
  onClose?: (context: BrowserContext) => void,
  initialUrl = "about:blank",
) {
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
    commit: (next: string) => {
      url = next;
    },
    title: vi.fn(async () => "test page"),
    viewportSize: vi.fn(() => viewport),
    setViewportSize: vi.fn(async (size: typeof viewport) => {
      viewport = size;
    }),
    goto: vi.fn(async (next: string) => {
      url = next;
      events.emit("load");
      await hooks.initialNavigation();
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
    newPage: vi.fn(async () => page as unknown as Page),
    grantPermissions: vi.fn(async () => {}),
    cookies: async () => [],
    newCDPSession: async (target: unknown) => {
      const failure = hooks.setupFailure();
      if (failure) throw failure;
      const session = makeSession(
        typeof target === "object" && target !== null && "recording" in target
          ? (target as ReturnType<typeof makeFrame>)
          : undefined,
        () => hooks.desktopSize() ?? Promise.resolve({ result: { value: { ...cssViewport } } }),
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

export const viewerInput = (tabId: string, canOperate: boolean) => ({
  threadId: scope.thread.threadId,
  tabId,
  canOperate,
  maxWidth: 1280,
  maxHeight: 800,
  quality: 70,
});
export const makeDesktopViewer = Effect.fn("TestBrowser.makeDesktopViewer")(function* (
  browser: ServerBrowser.ServerBrowser["Service"],
  manager: Manager.PreviewManager["Service"],
  selectNext: () => void,
  contextOf: () => ReturnType<typeof makePageContext>,
) {
  selectNext();
  const { tabId } = yield* manager.open({ threadId: scope.thread.threadId, runtime: "server" });
  const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
  const context = contextOf();
  const cdp = context.sessions[0];
  if (!cdp) throw new Error("The desktop viewer has no CDP session.");
  const resize = (width: number, height: number) => {
    Object.assign(context.cssViewport, { width, height });
    return Effect.promise(() => cdp.emitAsync("Page.frameResized"));
  };
  return { tabId, viewer, context, cdp, resize };
});

export const holdTitleObservation = ({ page, sessions }: ReturnType<typeof makePageContext>) => {
  const cdp = sessions[0];
  if (!cdp) throw new Error("The page has no CDP session.");
  const change = Promise.withResolvers<Record<string, unknown>>();
  const send = cdp.send.getMockImplementation();
  if (!send) throw new Error("The CDP session has no send handler.");
  const observeTitle = vi
    .fn(() => Promise.resolve({ result: { value: false } } as Record<string, unknown>))
    .mockImplementationOnce(() => change.promise);
  cdp.send.mockImplementation((method, params) =>
    method === "Runtime.evaluate" && (params as { contextId?: number })?.contextId === 17
      ? observeTitle()
      : method === "Page.createIsolatedWorld" &&
          (params as { worldName?: string }).worldName === "goat-preview-title"
        ? Promise.resolve({ executionContextId: 17 })
        : send(method, params),
  );
  return { page, observeTitle, change };
};

const crashRenderer = Effect.fn("TestBrowser.crashRenderer")(function* (
  original: ReturnType<typeof makePageContext>,
  browser: ServerBrowser.ServerBrowser["Service"],
  tabId: string,
  url: string,
  duringRecovery: "plain" | "stopAll" | "settle" | "failed" | "setupFailure",
) {
  const replacement = makePageContext({
    initialNavigation: () => undefined,
    setupFailure: () => null,
    desktopSize: () => undefined,
  });
  const context = original.page.context();
  replacement.page.context = () => context;
  context.newPage.mockImplementationOnce(replacement.newPage);
  original.page.commit(url);
  const paused = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  replacement.page.setViewportSize.mockImplementationOnce(async () => {
    paused.resolve();
    await resume.promise;
    if (duringRecovery === "failed" || duringRecovery === "setupFailure")
      throw new Error("Replacement renderer setup failed");
  });
  const key = { threadId: scope.thread.threadId, tabId };
  if (duringRecovery === "stopAll" || duringRecovery === "settle") {
    expect(
      yield* (
        browser.requestHandoff?.({
          ...key,
          reason: "Approve the sign-in",
          requestId: "recovery-request",
        }) ?? Effect.succeed(false)
      ),
    ).toBe(true);
  }
  const crash = yield* Effect.promise(() => original.page.emitAsync("crash")).pipe(
    Effect.forkChild,
  );
  yield* Effect.promise(() => paused.promise);
  if (duringRecovery === "stopAll") yield* browser.stopAllAgents;
  if (duringRecovery === "settle") yield* browser.endHandoff?.(key) ?? Effect.void;
  const applied =
    duringRecovery === "failed"
      ? yield* browser.controlSession({ ...key, control: "stop" })
      : undefined;
  resume.resolve();
  yield* Fiber.join(crash);

  if (duringRecovery === "failed") {
    expect(applied).toBe(true);
    expect((yield* browser.sessions).find((session) => session.tabId === tabId)).toBeUndefined();
    yield* browser.attachViewer(viewerInput(tabId, true));
    expect((yield* browser.sessions).find((session) => session.tabId === tabId)).toMatchObject({
      agentStopped: true,
    });
    expect(yield* browser.controlSession({ ...key, control: "handBack" })).toBe(true);
    expect((yield* browser.sessions).find((session) => session.tabId === tabId)).toMatchObject({
      agentStopped: false,
    });
    return replacement;
  }
  const sessions = yield* browser.sessions;
  if (duringRecovery === "setupFailure") {
    expect(sessions.find((session) => session.tabId === tabId)).toBeUndefined();
  } else if (duringRecovery !== "plain") {
    expect(sessions.find((session) => session.tabId === tabId)).toMatchObject({
      handoffReason: null,
      agentStopped: duringRecovery === "stopAll",
    });
  }
  return replacement;
});

export const assertCrashReload = Effect.fn("TestBrowser.assertCrashReload")(function* (
  context: ReturnType<typeof makePageContext>,
  browser: ServerBrowser.ServerBrowser["Service"],
  broker: Broker.PreviewAutomationBroker["Service"],
  tabId: PreviewTabId,
  duringRecovery: "plain" | "stopAll" | "settle" | "failed",
) {
  const url = `https://example.com/app?${"a".repeat(3000)}`;
  const replacement = yield* crashRenderer(context, browser, tabId, url, duringRecovery);
  if (duringRecovery === "failed") return;
  expect(replacement.newPage).toHaveBeenCalled();
  const status = yield* broker.invoke<PreviewAutomationStatus>({
    scope,
    tabId,
    operation: "status",
    input: {},
  });
  expect(status.tabId).toBe(tabId);
  expect(status.loadError).toEqual({
    url: url.slice(0, 2048),
    code: -2,
    description: "Page crashed",
  });
  // The crashed page cannot load anything again, so Reload goes to the page that replaced it.
  const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
  yield* viewer.input({ type: "takeControl" });
  yield* viewer.input({ type: "reload" });
  expect(replacement.page.goto).toHaveBeenCalledWith(url, expect.anything());
});

export interface ContextSetupGate {
  readonly promise: Promise<void>;
  readonly prepare?: (context: ReturnType<typeof makePageContext>) => void;
}

const assertStoppedOnReconnect = Effect.fn("TestBrowser.assertStoppedOnReconnect")(function* (
  browser: ServerBrowser.ServerBrowser["Service"],
  tabId: string,
  setSetupGate: (gate: ContextSetupGate | null) => void,
  stage: "context" | "viewport",
) {
  const paused = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  setSetupGate(
    stage === "context"
      ? {
          get promise() {
            paused.resolve();
            return resume.promise;
          },
        }
      : {
          promise: Promise.resolve(),
          prepare: ({ page }) => {
            page.setViewportSize.mockImplementationOnce(async () => {
              paused.resolve();
              await resume.promise;
            });
          },
        },
  );
  const reconnect = yield* browser.attachViewer(viewerInput(tabId, true)).pipe(Effect.forkChild);
  yield* Effect.promise(() => paused.promise);
  yield* browser.stopAllAgents;
  setSetupGate(null);
  resume.resolve();
  yield* Fiber.join(reconnect);
  expect((yield* browser.sessions).find((session) => session.tabId === tabId)).toMatchObject({
    agentStopped: true,
  });
});

export const assertStopThroughFailedRecovery = Effect.fn(
  "TestBrowser.assertStopThroughFailedRecovery",
)(function* (
  original: ReturnType<typeof makePageContext>,
  browser: ServerBrowser.ServerBrowser["Service"],
  tabId: string,
  setSetupGate: (gate: ContextSetupGate | null) => void,
  stage: "context" | "viewport",
) {
  const url = "https://example.com/";
  let live = original;
  if (stage === "viewport") {
    const key = { threadId: scope.thread.threadId, tabId };
    yield* browser.stopAllAgents;
    expect((yield* browser.sessions).find((session) => session.tabId === tabId)).toMatchObject({
      agentStopped: true,
    });
    expect(yield* browser.controlSession({ ...key, control: "handBack" })).toBe(true);
    live = yield* crashRenderer(live, browser, tabId, url, "stopAll");
    expect(yield* browser.controlSession({ ...key, control: "handBack" })).toBe(true);
  }
  yield* crashRenderer(live, browser, tabId, url, "setupFailure");
  yield* assertStoppedOnReconnect(browser, tabId, setSetupGate, stage);
});

export const framelessNavigationRequest = () => ({
  redirectedFrom: () => null,
  url: () => "https://example.com/early",
  method: () => "GET",
  isNavigationRequest: () => true,
  frame: () => {
    throw new Error("Frame unavailable");
  },
  failure: () => ({ errorText: "net::ERR_CONNECTION_REFUSED" }),
});
