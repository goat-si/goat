// @effect-diagnostics-next-line nodeBuiltinImport:off - static JPEG test fixtures are read outside the Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeEvents from "node:events";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { EnvironmentId, ThreadId, type PreviewAutomationStatus } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
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
import { makeSession, scope } from "./ServerBrowserTestFixtures.ts";

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
    async contextFor() {
      context = makeContext(this.onClose);
      return context as unknown as BrowserContext;
    }
    storePin = async () => undefined;
    pinStore = async (_profileId: string, store: string) => store;
    withProfile = <A>(_profileId: string, run: () => Promise<A>) => run();
    async close() {
      await context?.close();
    }
  },
}));

function makeContext(onClose?: (context: BrowserContext) => void) {
  const events = new NodeEvents.EventEmitter();
  const sessions: ReturnType<typeof makeSession>[] = [];
  let closed = false;
  let contextClosed = false;
  let url = "about:blank";
  const page = {
    on: (name: string, callback: (...args: unknown[]) => void) => events.on(name, callback),
    once: (name: string, callback: (...args: unknown[]) => void) => events.once(name, callback),
    off: (name: string, callback: (...args: unknown[]) => void) => events.off(name, callback),
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
    context: () => result,
    mainFrame: () => page,
    frames: () => [page],
    url: () => url,
    title: async () => "test page",
    viewportSize: () => ({ width: 1280, height: 800 }),
    setViewportSize: async () => {},
    goto: async (next: string) => {
      url = next;
      events.emit("load");
    },
    emulateMedia: async () => {},
    isClosed: () => closed,
    close: async () => {
      if (!closed) {
        closed = true;
        events.emit("close");
      }
    },
  };
  const result = {
    sessions,
    on: () => result,
    newPage: async () => page as unknown as Page,
    grantPermissions: async () => {},
    cookies: async () => [],
    newCDPSession: async () => {
      const session = makeSession();
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
    close: async () => {
      if (contextClosed) return;
      contextClosed = true;
      await page.close();
      onClose?.(result as unknown as BrowserContext);
    },
  };
  return result;
}
let context: ReturnType<typeof makeContext> | undefined;
const threadId = ThreadId.make("browser-test-thread");
const environmentId = EnvironmentId.make("browser-test-environment");
const dependencies = Layer.mergeAll(
  ServerSettings.layerTest(),
  historyMemoryLayer,
  Broker.layer,
  Manager.layer,
  Layer.succeed(ServerEnvironment.ServerEnvironment, {
    getEnvironmentId: Effect.succeed(environmentId),
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
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "goat-server-browser-" })),
  Layer.provideMerge(NodeServices.layer),
);
const layer = ServerBrowser.layer.pipe(Layer.provideMerge(dependencies));
const ready = Effect.gen(function* () {
  const browser = yield* ServerBrowser.ServerBrowser;
  const manager = yield* Manager.PreviewManager;
  const { tabId } = yield* manager.open({ threadId: threadId, runtime: "server" });
  return { browser, tabId };
});
const viewerInput = (tabId: string, canOperate: boolean) => ({
  threadId: threadId,
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
        const session = context!.sessions.at(-1)!;
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
// Upstream's ServerBrowser.test.ts case; that file is at its code budget.
it.effect("preview_open reports a tab it shows as visible once the client attaches", () =>
  Effect.scoped(
    Effect.gen(function* () {
      failure = null;
      fit = true;
      const browser = yield* ServerBrowser.ServerBrowser;
      const broker = yield* Broker.PreviewAutomationBroker;
      const manager = yield* Manager.PreviewManager;
      const events = yield* manager.subscribeEvents;
      yield* Effect.yieldNow;
      // Like a real client, the stream attaches asynchronously after the reveal request arrives.
      yield* Effect.gen(function* () {
        let event;
        do event = yield* PubSub.take(events);
        while (event.type !== "navigated" || !event.snapshot.revealRequest);
        yield* browser.attachViewer(viewerInput(event.tabId, false)).pipe(Effect.forkScoped);
      }).pipe(Effect.forkScoped);

      const opened = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "open",
        input: { reuseExistingTab: false, open: true },
      });

      expect(opened.visible).toBe(true);
    }),
  ).pipe(Effect.provide(layer)),
);
