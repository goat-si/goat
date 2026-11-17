import * as NodeEvents from "node:events";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  EnvironmentId,
  PreviewTabId,
  type PreviewAutomationResizeResult,
  type PreviewAutomationStatus,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
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

// Every desktop tab's page answers size reads with cssViewport unless a test replaces the answer.
const desktopPages: Array<ReturnType<typeof makeDesktopPage>> = [];
let sizeAnswer: (() => Promise<Record<string, unknown>>) | null = null;
vi.mock("./ServerBrowserContexts.ts", () => ({
  presentAsChrome: async () => {},
  ServerBrowserContexts: class {
    async contextFor(): Promise<never> {
      throw new Error("desktop tabs only");
    }
    storePin = async () => undefined;
    pinStore = async (_profileId: string, store: string) => store;
    withProfile = <A>(_profileId: string, run: () => Promise<A>) => run();
    async connectDesktopPage() {
      const desktop = makeDesktopPage();
      desktopPages.push(desktop);
      return { browser: { close: async () => {} }, page: desktop.page as unknown as Page };
    }
    async close() {}
  },
}));

function makeDesktopPage() {
  const events = new NodeEvents.EventEmitter();
  const sessions: Array<ReturnType<typeof makeSession>> = [];
  const cssViewport = { width: 1920, height: 1080 };
  let closed = false;
  const page = {
    on: (name: string, callback: (...args: unknown[]) => void) => events.on(name, callback),
    once: (name: string, callback: (...args: unknown[]) => void) => events.once(name, callback),
    off: (name: string, callback: (...args: unknown[]) => void) => events.off(name, callback),
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
    context: () => context,
    mainFrame: () => page,
    frames: () => [page],
    url: () => "about:blank",
    title: async () => "desktop page",
    viewportSize: () => null,
    setViewportSize: async () => {},
    goto: async () => {
      events.emit("load");
    },
    emulateMedia: async () => {},
    waitForLoadState: async () => {},
    evaluate: async () => undefined,
    isClosed: () => closed,
    close: async () => {
      if (closed) return;
      closed = true;
      events.emit("close");
    },
  };
  const context = {
    on: () => context,
    newPage: async () => page as unknown as Page,
    grantPermissions: async () => {},
    cookies: async () => [],
    newCDPSession: async () => {
      const session = makeSession(
        undefined,
        () => sizeAnswer?.() ?? Promise.resolve({ result: { value: { ...cssViewport } } }),
      );
      sessions.push(session);
      return session;
    },
    close: async () => page.close(),
  } as unknown as BrowserContext & { on: () => unknown };
  return { page, sessions, cssViewport };
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
    available: true,
    awaitAttached: () => Effect.succeed(true),
    detached: Stream.never,
    attached: Stream.never,
    isAttached: () => Effect.succeed(true),
    endpoint: (key) => Effect.succeed(`ws://desktop/${key.tabId}`),
    pointer: () => Effect.void,
    turn: () => Effect.void,
  }),
  PreviewAgentActivity.layer,
  Layer.mock(SecretRequests.SecretRequests)({}),
).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "goat-desktop-size-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);
const layer = ServerBrowser.layer.pipe(Layer.provideMerge(dependencies));

const failReads = () => Promise.reject(new Error("Cannot find context with specified id"));

const openDesktopTab = Effect.gen(function* () {
  yield* ServerBrowser.ServerBrowser;
  const broker = yield* Broker.PreviewAutomationBroker;
  const manager = yield* Manager.PreviewManager;
  yield* Effect.yieldNow;
  const opened = yield* broker.invoke<PreviewAutomationStatus>({
    scope,
    operation: "open",
    input: { reuseExistingTab: false, show: false, session: "profile" },
  });
  const tabId = PreviewTabId.make(opened.tabId!);
  const desktop = desktopPages.at(-1)!;
  const events = yield* manager.subscribeEvents;
  const status = broker
    .invoke<PreviewAutomationStatus>({ scope, tabId, operation: "status", input: {} })
    .pipe(Effect.map((result) => result.viewport));
  // The desktop draws the new size once the session update reaches it.
  const resize = (input: Record<string, unknown>, width: number, height: number) =>
    Effect.gen(function* () {
      const result = yield* broker
        .invoke<PreviewAutomationResizeResult>({ scope, tabId, operation: "resize", input })
        .pipe(Effect.forkScoped);
      let event = yield* PubSub.take(events);
      while (event.type !== "resized" || event.tabId !== tabId) event = yield* PubSub.take(events);
      Object.assign(desktop.cssViewport, { width, height });
      yield* Effect.promise(() => desktop.sessions[0]!.emitAsync("Page.frameResized"));
      return yield* Fiber.join(result);
    });
  return { status, resize };
});

it.effect("a desktop tab's resize reports the size the desktop draws", () =>
  Effect.scoped(
    Effect.gen(function* () {
      sizeAnswer = null;
      const { status, resize } = yield* openDesktopTab;

      const freeform = yield* resize({ mode: "freeform", width: 900, height: 600 }, 900, 600);
      expect(freeform.viewport).toEqual({ width: 900, height: 600 });
      // A page can keep another size than the fixed one asked for; both report the page's.
      const kept = yield* resize({ mode: "freeform", width: 844, height: 390 }, 560, 760);
      expect(kept.viewport).toEqual({ width: 560, height: 760 });
      expect(yield* status).toEqual({ width: 560, height: 760 });
      expect((yield* resize({ mode: "fill" }, 1234, 700)).viewport).toEqual({
        width: 1234,
        height: 700,
      });
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect(
  "a desktop tab's resize whose read fails or meets a page resize gives no old size as the new one",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        sizeAnswer = null;
        const { resize } = yield* openDesktopTab;
        const desktop = desktopPages.at(-1)!;
        const kept = yield* resize({ mode: "freeform", width: 844, height: 390 }, 560, 760);
        expect(kept.viewport).toEqual({ width: 560, height: 760 });
        const messageOf = (error: unknown) => String((error as { message?: string }).message);

        sizeAnswer = failReads;
        const unread = yield* resize(
          { mode: "freeform", width: 1000, height: 700 },
          1000,
          700,
        ).pipe(Effect.flip);
        expect(messageOf(unread)).toContain("The setting is applied");

        // The page resizes again while the size is read, so that answer may already be old.
        sizeAnswer = async () => {
          await desktop.sessions[0]!.emitAsync("Page.frameResized");
          return { result: { value: { width: 1100, height: 700 } } };
        };
        const raced = yield* resize({ mode: "freeform", width: 1100, height: 700 }, 1100, 700).pipe(
          Effect.flip,
        );
        expect(messageOf(raced)).toContain("The setting is applied");
        sizeAnswer = null;
      }),
    ).pipe(Effect.provide(layer)),
);

it.effect("a desktop tab that was never measured says so instead of reporting a size", () =>
  Effect.scoped(
    Effect.gen(function* () {
      sizeAnswer = failReads;
      const { status, resize } = yield* openDesktopTab;
      const error = yield* resize({ mode: "freeform", width: 900, height: 600 }, 900, 600).pipe(
        Effect.flip,
      );
      expect(error).toMatchObject({ remoteTag: "PreviewAutomationExecutionError" });
      expect(String((error as { message?: string }).message)).toContain(
        "has not measured this desktop tab",
      );
      expect(yield* status).toBeUndefined();
    }),
  ).pipe(Effect.provide(layer)),
);
