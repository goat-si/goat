import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  EnvironmentId,
  PreviewTabId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type PreviewAutomationStatus,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { expect, vi } from "vite-plus/test";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { createGuardedHttpServer } from "../httpResponseErrorGuard.ts";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as DesktopChannel from "./DesktopBrowserChannel.ts";
import * as Manager from "./Manager.ts";
import * as PreviewAgentActivity from "./PreviewAgentActivity.ts";
import * as PreviewBrowser from "./PreviewBrowser.ts";
import { unusedPreviewBrowser } from "./PreviewBrowser.testkit.ts";
import * as ServerBrowser from "./ServerBrowser.ts";

let browser: Browser | undefined;
const contexts: Array<BrowserContext> = [];
vi.mock("./ServerBrowserContexts.ts", () => ({
  presentAsChrome: async () => {},
  ServerBrowserContexts: class {
    async contextFor() {
      browser ??= await chromium.launch({ headless: true });
      const context = await browser.newContext();
      contexts.push(context);
      return context;
    }
    async scratchPage() {
      browser ??= await chromium.launch({ headless: true });
      return browser.newPage();
    }
    async close() {
      for (const context of contexts.splice(0)) await context.close();
      await browser?.close();
      browser = undefined;
    }
  },
}));

const threadId = ThreadId.make("click-popup-id-thread");
const scope = {
  environmentId: EnvironmentId.make("click-popup-id-env"),
  thread: {
    threadId,
    providerSessionId: "agent-a",
    providerInstanceId: ProviderInstanceId.make("codex"),
    runId: RunId.make("run"),
  },
  client: undefined,
  requestNamespace: "click-popup-id-test",
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};

const layer = ServerBrowser.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      SqlitePersistence.layerMemory,
      ServerSettings.layerTest(),
      Manager.layer,
      Broker.layer,
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.succeed(ServerEnvironment.ServerEnvironment, {
        getEnvironmentId: Effect.succeed(scope.environmentId),
        getDescriptor: Effect.die("unused"),
      }),
      Layer.succeed(PreviewBrowser.PreviewBrowser, unusedPreviewBrowser),
      Layer.succeed(DesktopChannel.DesktopBrowserChannel, {
        available: false,
        awaitAttached: () => Effect.succeed(false),
        detached: Stream.empty,
        attached: Stream.empty,
        isAttached: () => Effect.succeed(false),
        endpoint: () => Effect.die("unused"),
        pointer: () => Effect.void,
        turn: () => Effect.void,
      }),
      PreviewAgentActivity.layer,
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "goat-click-popup-id-" })),
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ),
  ),
);

it.effect("a click that opens an adopted popup returns its openedTabId", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const services = yield* Layer.build(
        HttpRouter.serve(
          HttpRouter.add(
            "GET",
            "/safe",
            Effect.sync(() => HttpServerResponse.html('<button id="next">next</button>')),
          ),
          { disableListenLog: true, disableLogger: true },
        ).pipe(
          Layer.provideMerge(
            NodeHttpServer.layer(createGuardedHttpServer, { port: 0, host: "127.0.0.1" }),
          ),
        ),
      );
      const port = Number(
        new URL(HttpServer.formatAddress(Context.get(services, HttpServer.HttpServer).address))
          .port,
      );
      const allowed = `http://127.0.0.1:${port}`;
      const service = yield* ServerBrowser.ServerBrowser;
      const broker = yield* Broker.PreviewAutomationBroker;
      const activity = yield* PreviewAgentActivity.PreviewAgentActivity;
      const end = yield* activity.begin(threadId, "run");
      yield* Effect.addFinalizer(() => end);
      yield* Effect.yieldNow;
      const opened = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "open",
        input: { url: `${allowed}/safe`, reuseExistingTab: false, show: false },
      });
      if (typeof opened.tabId !== "string") throw new Error("Expected opened tabId");
      const tabId = PreviewTabId.make(opened.tabId);
      const page = contexts.at(-1)?.pages()[0];
      if (!page) throw new Error("Expected opened browser page");
      yield* Effect.promise(() =>
        page.locator("#next").evaluate((button, url) => {
          button.setAttribute("onclick", `window.open('${url}')`);
        }, `${allowed}/safe`),
      );
      const clicked = (yield* broker.invoke({
        scope,
        tabId,
        operation: "click",
        input: { locator: "#next" },
      })) as {
        readonly effect?: string;
        readonly evidence?: ReadonlyArray<string>;
        readonly openedTabId?: string;
      };
      const sessions = yield* service.sessions;
      const popupTab = sessions.find((view) => view.tabId !== tabId);
      expect(popupTab).toBeDefined();
      expect(clicked.openedTabId).toBe(popupTab?.tabId);
      expect(clicked.effect).toBe("confirmed");
      expect(clicked.evidence).toContain("popup");
    }),
  ).pipe(Effect.provide(layer)),
);
