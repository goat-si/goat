import * as NodeEvents from "node:events";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { EnvironmentId, PreviewTabId, type PreviewAutomationStatus } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
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
import { makeEncoderPage, mockFinalRecordingFrame } from "./RecordingEncoder.testkit.ts";
import * as ServerBrowser from "./ServerBrowser.ts";
import { makeSession, scope } from "./ServerBrowserTestFixtures.ts";

const contexts: Array<ReturnType<typeof makeContext>> = [];
// The encoder page fails to decode the frames listed here.
const undecodable = new Set<string>();
vi.mock("./ServerBrowserContexts.ts", () => ({
  presentAsChrome: async () => {},
  ServerBrowserContexts: class {
    async contextFor() {
      const context = makeContext();
      contexts.push(context);
      return context as unknown as BrowserContext;
    }
    storePin = async () => undefined;
    pinStore = async (_profileId: string, store: string) => store;
    withProfile = <A>(_profileId: string, run: () => Promise<A>) => run();
    async scratchPage() {
      let decoding = 0;
      return makeEncoderPage(makeContext().page, [], () => {
        decoding += 1;
        return undecodable.has(String(decoding))
          ? Promise.reject(new Error("The source image cannot be decoded."))
          : undefined;
      }) as unknown as Page;
    }
    async close() {}
  },
}));

function makeContext() {
  const events = new NodeEvents.EventEmitter();
  const sessions: Array<ReturnType<typeof makeSession>> = [];
  let url = "about:blank";
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
    viewportSize: () => ({ width: 1280, height: 800 }),
    setViewportSize: async () => {},
    goto: async (next: string) => {
      url = next;
      events.emit("load");
    },
    emulateMedia: async () => {},
    isClosed: () => false,
    close: async () => {},
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
    close: async () => {},
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
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "goat-recording-encoder-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);
const layer = ServerBrowser.layer.pipe(Layer.provideMerge(dependencies));

it.effect("a frame the encoder cannot take is dropped and the recording keeps going", () =>
  Effect.scoped(
    Effect.gen(function* () {
      undecodable.clear();
      undecodable.add("2");
      yield* ServerBrowser.ServerBrowser;
      const broker = yield* Broker.PreviewAutomationBroker;
      const fs = yield* FileSystem.FileSystem;
      yield* Effect.yieldNow;
      const opened = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "open",
        input: { reuseExistingTab: false, show: false },
      });
      const tabId = PreviewTabId.make(opened.tabId!);
      yield* broker.invoke({ scope, tabId, operation: "recordingStart", input: {} });
      const context = contexts.at(-1)!;
      const recording = context.sessions.at(-1)!;
      const frame = (data: string, sessionId: number) =>
        recording.emitAsync("Page.screencastFrame", {
          data: Buffer.from(data).toString("base64"),
          sessionId,
          metadata: { deviceWidth: 1280 },
        });
      yield* Effect.promise(() => frame("broken", 1));
      yield* Effect.promise(() => frame("after", 2));
      mockFinalRecordingFrame(context.sessions[0]!, true);
      const artifact = yield* broker.invoke<{ path: string }>({
        scope,
        tabId,
        operation: "recordingStop",
        input: {},
      });
      expect(yield* fs.readFileString(artifact.path)).toBe("after");
    }),
  ).pipe(Effect.provide(layer)),
);
