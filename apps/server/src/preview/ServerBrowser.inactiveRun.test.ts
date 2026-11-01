// @effect-diagnostics nodeBuiltinImport:off - local HTTP fixture for Chromium navigation.
import * as NodeHttp from "node:http";
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
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { chromium, type Browser, type BrowserContext } from "playwright-core";
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
import * as ServerBrowser from "./ServerBrowser.ts";

let browser: Browser | undefined;
const contexts: BrowserContext[] = [];
let shareNextContext = false;
vi.mock("./ServerBrowserContexts.ts", () => ({
  presentAsChrome: async () => {},
  ServerBrowserContexts: class {
    async contextFor() {
      if (shareNextContext) {
        shareNextContext = false;
        return contexts.at(-1)!;
      }
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
const threadId = ThreadId.make("blocked-navigation-thread");
const scope = {
  environmentId: EnvironmentId.make("blocked-navigation-env"),
  thread: {
    threadId,
    providerSessionId: "agent-a",
    providerInstanceId: ProviderInstanceId.make("codex"),
    runId: RunId.make("run"),
  },
  client: undefined,
  requestNamespace: "blocked-navigation-test",
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};
const layer = ServerBrowser.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
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
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "goat-blocked-nav-" })),
      Layer.provideMerge(NodeServices.layer),
    ),
  ),
);

const fixture = Effect.gen(function* () {
  const hits: string[] = [];
  const slowStarted = yield* Deferred.make<void>();
  const slowGate = yield* Deferred.make<void>();
  const slowRelease = Promise.withResolvers<void>();
  yield* Deferred.await(slowGate).pipe(
    Effect.andThen(Effect.sync(() => slowRelease.resolve())),
    Effect.forkScoped,
  );
  let serverPort = 0;
  const server = yield* Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<NodeHttp.Server>((resolve) => {
          const server = NodeHttp.createServer((req, res) => {
            const port = serverPort;
            const blocked = `http://localhost:${port}`;
            const allowed = `http://127.0.0.1:${port}`;
            hits.push(`${req.headers.host}${req.url}`);
            if (req.url === "/slow") {
              Deferred.doneUnsafe(slowStarted, Effect.void);
              void slowRelease.promise.then(() => {
                res.writeHead(200, { "content-type": "text/html" });
                res.end("slow");
              });
              return;
            }
            if (req.url === "/redirect") {
              res.writeHead(302, { location: `${blocked}/hop` });
              res.end();
              return;
            }
            if (req.url === "/hop") {
              res.writeHead(302, { location: `${allowed}/safe` });
              res.end();
              return;
            }
            res.writeHead(200, { "content-type": "text/html" });
            res.end(
              `<a id="link" href="${blocked}/blocked">go</a><button id="popup" onclick="window.open('${blocked}/blocked')">popup</button><button id="slowPopup" onclick="window.open('${blocked}/slow')">slow popup</button><button id="popupRedirect" onclick="window.open('${allowed}/redirect')">redirect popup</button><form action="${blocked}/blocked"><button id="form">submit</button></form><button id="script" onclick="location.href='${blocked}/blocked'">script</button><button id="popupBlank" onclick="const p=window.open('about:blank');p.location.href='${blocked}/blocked'">blank popup</button><button id="next">next</button>`,
            );
          });
          server.listen(0, () => {
            serverPort = (server.address() as { port: number }).port;
            resolve(server);
          });
        }),
    ),
    (server) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
  yield* Effect.addFinalizer(() => Effect.sync(() => slowRelease.resolve()));
  const port = (server.address() as { port: number }).port;
  const allowed = `http://127.0.0.1:${port}`;
  const blocked = `http://localhost:${port}`;
  const service = yield* ServerBrowser.ServerBrowser;
  const broker = yield* Broker.PreviewAutomationBroker;
  const settings = yield* ServerSettings.ServerSettingsService;
  const activity = yield* PreviewAgentActivity.PreviewAgentActivity;
  const end = yield* activity.begin(threadId, "run");
  yield* Effect.addFinalizer(() => end);
  yield* Effect.yieldNow;
  const opened = yield* broker.invoke<PreviewAutomationStatus>({
    scope,
    operation: "open",
    input: { url: `${allowed}/safe`, reuseExistingTab: false, show: false },
  });
  const tabId = PreviewTabId.make(opened.tabId!);
  const page = contexts.at(-1)!.pages()[0]!;
  yield* settings.updateSettings({ blockedBrowserHosts: ["localhost"] });
  const call = (
    id: PreviewTabId,
    operation: Broker.PreviewAutomationInvokeInput["operation"],
    input: unknown,
  ) => broker.invoke({ scope, tabId: id, operation, input });
  return {
    service,
    broker,
    page,
    tabId,
    allowed,
    blocked,
    hits,
    end,
    call,
    settings,
    slowStarted,
    slowGate,
  };
});
it.effect("a blocked visit outside a turn does not fence a later turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.end;
      yield* Effect.promise(() => f.page.goto(`${f.blocked}/blocked`));
      yield* Effect.promise(() => f.page.goto(`${f.allowed}/safe`));
      const stale = yield* f.call(f.tabId, "press", { key: "Enter" }).pipe(Effect.result);
      expect(stale).toMatchObject({
        _tag: "Failure",
        failure: { reason: "interrupted", dispatched: false },
      });
      const neverStarted = {
        ...scope,
        thread: { ...scope.thread, runId: RunId.make("never-started") },
      };
      expect(
        yield* f.broker
          .invoke({
            scope: neverStarted,
            tabId: f.tabId,
            operation: "press",
            input: { key: "Enter" },
          })
          .pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure", failure: { reason: "interrupted", dispatched: false } });
      expect((yield* f.call(f.tabId, "status", {}).pipe(Effect.result))._tag).toBe("Success");
      const { runId: _runId, ...threadWithoutRun } = scope.thread;
      const noRunScope = { ...scope, thread: threadWithoutRun };
      expect(
        (yield* f.broker
          .invoke({
            scope: noRunScope,
            tabId: f.tabId,
            operation: "press",
            input: { key: "Enter" },
          })
          .pipe(Effect.result))._tag,
      ).toBe("Success");
      const activity = yield* PreviewAgentActivity.PreviewAgentActivity;
      const endNext = yield* activity.begin(threadId, "next-run");
      const nextScope = { ...scope, thread: { ...scope.thread, runId: RunId.make("next-run") } };
      expect(
        (yield* f.broker
          .invoke({ scope: nextScope, tabId: f.tabId, operation: "press", input: { key: "Enter" } })
          .pipe(Effect.result))._tag,
      ).toBe("Success");
      yield* endNext;
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("a captured request is refused when its run ends before browser admission", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const captured = yield* Deferred.make<void>();
      const admit = yield* Deferred.make<void>();
      const keydown = vi.fn();
      yield* Effect.promise(() => f.page.exposeFunction("recordStaleKey", keydown));
      yield* Effect.promise(() =>
        f.page.evaluate(`document.addEventListener("keydown", () => globalThis.recordStaleKey())`),
      );
      const pending = yield* Effect.gen(function* () {
        const capturedScope = scope;
        yield* Deferred.succeed(captured, undefined);
        yield* Deferred.await(admit);
        return yield* f.broker
          .invoke({
            scope: capturedScope,
            tabId: f.tabId,
            operation: "press",
            input: { key: "Enter" },
          })
          .pipe(Effect.result);
      }).pipe(Effect.forkChild);
      yield* Deferred.await(captured);
      yield* f.end;
      yield* Deferred.succeed(admit, undefined);
      const result = yield* Fiber.join(pending);
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { reason: "interrupted", dispatched: false },
      });
      expect(keydown).not.toHaveBeenCalled();
    }),
  ).pipe(Effect.provide(layer)),
);
