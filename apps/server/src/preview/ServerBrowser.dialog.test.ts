import * as NodeEvents from "node:events";

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
import * as Stream from "effect/Stream";
import { expect, vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import * as DesktopChannel from "./DesktopBrowserChannel.ts";
import * as Manager from "./Manager.ts";
import * as PreviewBrowser from "./PreviewBrowser.ts";
import { unusedPreviewBrowser } from "./PreviewBrowser.testkit.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PreviewAgentActivity from "./PreviewAgentActivity.ts";
import * as ServerBrowser from "./ServerBrowser.ts";
import * as ServerSettings from "../serverSettings.ts";

import { makeSession } from "./ServerBrowserTestFixtures.ts";

// One fake Chromium context per test; its page refuses every locator, so input never lands.
const contexts: Array<ReturnType<typeof makeContext>> = [];
vi.mock("./ServerBrowserContexts.ts", () => ({
  presentAsChrome: async () => {},
  ServerBrowserContexts: class {
    async contextFor() {
      const context = makeContext();
      contexts.push(context);
      return context;
    }
    async scratchPage() {
      return { evaluate: async () => true, close: async () => {} };
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
    exposeBinding: async () => {},
    addInitScript: async () => {},
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
    locator: vi.fn(() => {
      throw new Error("Unexpected locator action");
    }),
    isClosed: () => false,
    close: async () => {},
  };
  const context = {
    page,
    on: () => context,
    newPage: async () => page,
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
  capabilities: new Set<"preview">(["preview"]),
  issuedAt: 1,
};

const layer = ServerBrowser.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      SqlitePersistence.layerMemory,
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

it.live("dialog refusal reports no pending dialog before input", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const result = yield* broker
        .invoke<void>({
          scope,
          tabId,
          operation: "dialog",
          input: { accept: false },
        })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag !== "Failure") throw new Error("Expected dialog refusal");
      const error = result.failure;
      expect(error._tag).toBe("PreviewAutomationExecutionError");
      if (error._tag !== "PreviewAutomationExecutionError") throw error;
      expect(error).toMatchObject({ reason: "No dialog is pending.", dispatched: false });
    }),
  ).pipe(Effect.provide(layer)),
);
