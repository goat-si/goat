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
import { ServerBrowserContexts } from "./ServerBrowserContexts.ts";

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

it.effect("an unattributed blocked popup fences all active tabs in its context", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      shareNextContext = true;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          shareNextContext = false;
        }),
      );
      const opened = yield* f.broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "open",
        input: { reuseExistingTab: false, show: false },
      });
      const other = PreviewTabId.make(opened.tabId!);
      const opening = yield* Effect.promise(() =>
        f.page.evaluate(`window.open(${JSON.stringify(`${f.blocked}/slow`)})`),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(f.slowStarted);
      const first = yield* f.call(f.tabId, "press", { key: "Enter" }).pipe(Effect.result);
      const second = yield* f.call(other, "press", { key: "Enter" }).pipe(Effect.result);
      yield* Deferred.succeed(f.slowGate, undefined);
      yield* Fiber.join(opening);
      blocked(first);
      blocked(second);
    }),
  ).pipe(Effect.provide(layer)),
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
const blocked = (result: { readonly _tag: string; readonly failure?: unknown }) => {
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure")
    expect(result.failure).toMatchObject({ reason: "blocked_url", dispatched: false });
};

it.effect("an agent link to a blocked host fences the tab", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const arrived = f.page.waitForURL(`${f.blocked}/blocked`);
      yield* f.call(f.tabId, "click", { locator: "#link" }).pipe(Effect.result);
      yield* Effect.promise(() => arrived);
      yield* Effect.promise(() => f.page.goto(`${f.allowed}/safe`));
      blocked(yield* f.call(f.tabId, "press", { key: "Enter" }).pipe(Effect.result));
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("a redirect through a blocked host fences the tab after reaching an allowed host", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.promise(() => f.page.goto(`${f.allowed}/redirect`));
      expect(f.hits.some((hit) => hit.startsWith("localhost:") && hit.endsWith("/hop"))).toBe(true);
      blocked(yield* f.call(f.tabId, "press", { key: "Enter" }).pipe(Effect.result));
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("a blocked popup fences the popup and its opener", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const popupReady = f.page.waitForEvent("popup");
      yield* f.call(f.tabId, "click", { locator: "#popup" }).pipe(Effect.result);
      const popup = yield* Effect.promise(() => popupReady);
      yield* Effect.promise(() => popup.waitForURL(`${f.blocked}/blocked`));
      const newTab = yield* Stream.merge(Stream.succeed(undefined), f.service.sessionChanges).pipe(
        Stream.mapEffect(() => f.service.sessions),
        Stream.filter((views) => views.some((view) => view.tabId !== f.tabId)),
        Stream.runHead,
      );
      if (newTab._tag === "None") return yield* Effect.die("popup not adopted");
      const tab = newTab.value.find((view) => view.tabId !== f.tabId)!;
      yield* Effect.promise(() => popup.goto(`${f.allowed}/safe`));
      blocked(yield* f.call(f.tabId, "press", { key: "Enter" }).pipe(Effect.result));
      blocked(
        yield* f.call(PreviewTabId.make(tab.tabId), "press", { key: "Enter" }).pipe(Effect.result),
      );
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("a person's blocked visit during the turn fences the tab", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const viewer = yield* f.service.attachViewer({
        threadId,
        tabId: f.tabId,
        canOperate: true,
        maxWidth: 1280,
        maxHeight: 800,
        quality: 70,
      });
      yield* viewer.input({ type: "takeControl" });
      yield* Effect.promise(() => f.page.goto(`${f.blocked}/blocked`));
      yield* Effect.promise(() => f.page.goto(`${f.allowed}/safe`));
      yield* viewer.input({ type: "releaseControl" });
      blocked(yield* f.call(f.tabId, "press", { key: "Enter" }).pipe(Effect.result));
    }),
  ).pipe(Effect.provide(layer)),
);

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
        f.page.evaluate(() => {
          document.addEventListener("keydown", () =>
            (globalThis as unknown as { recordStaleKey: () => void }).recordStaleKey(),
          );
        }),
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

it.effect("a popup redirect through a blocked host fences the popup and its opener", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const popupReady = f.page.waitForEvent("popup");
      yield* f.call(f.tabId, "click", { locator: "#popupRedirect" }).pipe(Effect.result);
      const popup = yield* Effect.promise(() => popupReady);
      yield* Effect.promise(() => popup.waitForURL(`${f.allowed}/safe`));
      const newTab = yield* Stream.merge(Stream.succeed(undefined), f.service.sessionChanges).pipe(
        Stream.mapEffect(() => f.service.sessions),
        Stream.filter((views) => views.some((view) => view.tabId !== f.tabId)),
        Stream.runHead,
      );
      if (newTab._tag === "None") return yield* Effect.die("popup not adopted");
      const tab = newTab.value.find((view) => view.tabId !== f.tabId)!;
      expect(f.hits.some((hit) => hit.startsWith("localhost:") && hit.endsWith("/hop"))).toBe(true);
      blocked(yield* f.call(f.tabId, "press", { key: "Enter" }).pipe(Effect.result));
      blocked(
        yield* f.call(PreviewTabId.make(tab.tabId), "press", { key: "Enter" }).pipe(Effect.result),
      );
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("a form submission to a blocked host fences the tab", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const arrived = f.page.waitForURL(`${f.blocked}/blocked?`);
      yield* f.call(f.tabId, "click", { locator: "#form" }).pipe(Effect.result);
      yield* Effect.promise(() => arrived);
      yield* Effect.promise(() => f.page.goto(`${f.allowed}/safe`));
      blocked(yield* f.call(f.tabId, "press", { key: "Enter" }).pipe(Effect.result));
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("a script navigation to a blocked host fences the tab", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const arrived = f.page.waitForURL(`${f.blocked}/blocked`);
      yield* f.call(f.tabId, "click", { locator: "#script" }).pipe(Effect.result);
      yield* Effect.promise(() => arrived);
      yield* Effect.promise(() => f.page.goto(`${f.allowed}/safe`));
      blocked(yield* f.call(f.tabId, "press", { key: "Enter" }).pipe(Effect.result));
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("a popup navigated after opening blank fences the popup and its opener", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const popupReady = f.page.waitForEvent("popup");
      yield* f.call(f.tabId, "click", { locator: "#popupBlank" }).pipe(Effect.result);
      const popup = yield* Effect.promise(() => popupReady);
      yield* Effect.promise(() => popup.waitForURL(`${f.blocked}/blocked`));
      const newTab = yield* Stream.merge(Stream.succeed(undefined), f.service.sessionChanges).pipe(
        Stream.mapEffect(() => f.service.sessions),
        Stream.filter((views) => views.some((view) => view.tabId !== f.tabId)),
        Stream.runHead,
      );
      if (newTab._tag === "None") return yield* Effect.die("popup not adopted");
      const tab = newTab.value.find((view) => view.tabId !== f.tabId)!;
      yield* Effect.promise(() => popup.goto(`${f.allowed}/safe`));
      blocked(yield* f.call(f.tabId, "press", { key: "Enter" }).pipe(Effect.result));
      blocked(
        yield* f.call(PreviewTabId.make(tab.tabId), "press", { key: "Enter" }).pipe(Effect.result),
      );
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("a blocked iframe navigation fences its containing tab", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const loaded = f.page.waitForResponse(`${f.blocked}/blocked`);
      yield* Effect.promise(() =>
        f.page.evaluate(
          `(() => { const frame = document.createElement("iframe"); frame.src = ${JSON.stringify(`${f.blocked}/blocked`)}; document.body.append(frame); })()`,
        ),
      );
      yield* Effect.promise(() => loaded);
      blocked(yield* f.call(f.tabId, "press", { key: "Enter" }).pipe(Effect.result));
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("an iframe blocked after loading refuses input before it reaches the frame", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.settings.updateSettings({ blockedBrowserHosts: [] });
      yield* Effect.promise(() =>
        f.page.evaluate(
          `(() => { const frame = document.createElement("iframe"); frame.id = "child"; frame.src = ${JSON.stringify(`${f.blocked}/blocked`)}; document.body.append(frame); })()`,
        ),
      );
      const frame = f.page.frameLocator("#child");
      yield* Effect.promise(() => frame.locator("#next").waitFor());
      const child = f.page.frames().find((item) => item.url() === `${f.blocked}/blocked`)!;
      yield* Effect.promise(() =>
        child.evaluate(
          "document.querySelector('#next').addEventListener('click', () => document.querySelector('#next').setAttribute('data-clicked','yes'))",
        ),
      );
      yield* f.settings.updateSettings({ blockedBrowserHosts: ["localhost"] });
      const result = yield* f
        .call(f.tabId, "click", { locator: "#child >> internal:control=enter-frame >> #next" })
        .pipe(Effect.result);
      blocked(result);
      expect(
        yield* Effect.promise(() => frame.locator("#next").getAttribute("data-clicked")),
      ).toBeNull();
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("an allowed iframe remains usable when no frame is blocked", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.promise(() =>
        f.page.evaluate(
          `(() => { const frame = document.createElement("iframe"); frame.id = "child"; frame.src = ${JSON.stringify(`${f.allowed}/safe`)}; document.body.append(frame); })()`,
        ),
      );
      yield* Effect.promise(() => f.page.frameLocator("#child").locator("#next").waitFor());
      expect(
        (yield* f
          .call(f.tabId, "click", { locator: "#child >> internal:control=enter-frame >> #next" })
          .pipe(Effect.result))._tag,
      ).toBe("Success");
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("opening a URL that redirects through a blocked host reports dispatched", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const result = yield* f.broker
        .invoke({
          scope,
          operation: "open",
          input: { url: `${f.allowed}/redirect`, reuseExistingTab: false, show: false },
        })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({ reason: "blocked_url", dispatched: true });
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("opening an initially blocked URL is refused before dispatch", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const result = yield* f.broker
        .invoke({
          scope,
          operation: "open",
          input: { url: `${f.blocked}/blocked`, reuseExistingTab: false, show: false },
        })
        .pipe(Effect.result);
      blocked(result);
      expect(f.hits.some((hit) => hit.startsWith("localhost:") && hit.endsWith("/blocked"))).toBe(
        false,
      );
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("a slow blocked popup fences active context tabs before the response arrives", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const opening = yield* Effect.promise(() =>
        f.page.evaluate(`window.open(${JSON.stringify(`${f.blocked}/slow`)})`),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(f.slowStarted);
      const result = yield* f.call(f.tabId, "press", { key: "Enter" }).pipe(Effect.result);
      yield* Deferred.succeed(f.slowGate, undefined);
      yield* Fiber.join(opening);
      blocked(result);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("a blocked popup at the tab limit still fences its opener", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      for (let i = 1; i < 8; i++) {
        yield* f.broker.invoke({
          scope,
          operation: "open",
          input: { reuseExistingTab: false, show: false },
        });
      }
      const popupReady = f.page.waitForEvent("popup");
      yield* f.call(f.tabId, "click", { locator: "#popup" }).pipe(Effect.result);
      const popup = yield* Effect.promise(() => popupReady);
      if (!popup.isClosed()) yield* Effect.promise(() => popup.waitForEvent("close"));
      blocked(yield* f.call(f.tabId, "press", { key: "Enter" }).pipe(Effect.result));
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("fetch on a fenced tab sends no new HTTP request", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.promise(() => f.page.goto(`${f.blocked}/blocked`));
      yield* Effect.promise(() => f.page.goto(`${f.allowed}/safe`));
      const result = yield* f
        .call(f.tabId, "fetch", { url: `${f.allowed}/fetch-fenced` })
        .pipe(Effect.result);
      blocked(result);
      expect(f.hits.some((hit) => hit.endsWith("/fetch-fenced"))).toBe(false);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("fetch to a blocked destination sends no HTTP request", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const result = yield* f
        .call(f.tabId, "fetch", { url: `${f.blocked}/fetch-blocked` })
        .pipe(Effect.result);
      blocked(result);
      expect(f.hits.some((hit) => hit.endsWith("/fetch-blocked"))).toBe(false);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("a blocked visit during resize prevents a second viewport command", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const viewer = yield* f.service.attachViewer({
        threadId,
        tabId: f.tabId,
        canOperate: true,
        maxWidth: 1280,
        maxHeight: 800,
        quality: 70,
      });
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const latch = Promise.withResolvers<void>();
      yield* Effect.forkChild(
        Deferred.await(resume).pipe(Effect.tap(() => Effect.sync(latch.resolve))),
      );
      const original = f.page.setViewportSize.bind(f.page);
      const viewport = vi.spyOn(f.page, "setViewportSize").mockImplementation(async (size) => {
        await original(size);
        Deferred.doneUnsafe(entered, Effect.void);
        await latch.promise;
      });
      const resize = yield* f
        .call(f.tabId, "resize", { mode: "freeform", width: 900, height: 700 })
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(entered);
      yield* Effect.promise(() => f.page.goto(`${f.blocked}/blocked`));
      const taking = yield* viewer.input({ type: "takeControl" }).pipe(Effect.forkChild);
      yield* Deferred.succeed(resume, undefined);
      const result = yield* Fiber.join(resize);
      yield* Fiber.join(taking);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({ reason: "blocked_url" });
      expect(viewport).toHaveBeenCalledOnce();
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect.each([
  ["open", { reuseExistingTab: true, show: false }],
  ["navigate", { url: "http://127.0.0.1/" }],
  ["snapshot", { captureImage: false }],
  ["click", { x: 1, y: 1 }],
  ["type", { text: "x" }],
  ["press", { key: "Enter" }],
  ["scroll", { deltaY: 1 }],
  ["evaluate", { expression: "1" }],
  ["waitFor", { text: "next" }],
  ["recordingStart", {}],
  ["resize", { mode: "freeform", width: 800, height: 600 }],
  ["setColorScheme", { colorScheme: "dark" }],
  ["claim", {}],
  ["dialog", { accept: true }],
  ["upload", { paths: [] }],
  ["hover", { x: 1, y: 1 }],
  ["select", { locator: "#next", values: [] }],
  ["drag", { from: { x: 1, y: 1 }, to: { x: 2, y: 2 } }],
  ["back", {}],
  ["forward", {}],
  ["reload", {}],
  ["logs", {}],
  ["fetch", { url: "/probe" }],
  ["scrollCollect", { url: "/probe" }],
  ["fillSecret", {}],
  ["read", {}],
  ["signInState", {}],
] as const)("a fenced tab refuses %s before browser commands", ([operation, input]) =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.promise(() => f.page.goto(`${f.blocked}/blocked`));
      yield* Effect.promise(() => f.page.goto(`${f.allowed}/safe`));
      const probe = yield* Effect.promise(() => f.page.context().newCDPSession(f.page));
      const protocol = vi.spyOn(
        Object.getPrototypeOf(probe) as { send: typeof probe.send },
        "send",
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => protocol.mockRestore()));
      const evaluate = vi.spyOn(f.page, "evaluate");
      const evaluateHandle = vi.spyOn(f.page, "evaluateHandle");
      const navigate = vi.spyOn(f.page, "goto");
      const locator = vi.spyOn(f.page, "locator");
      const inputCommands = [
        vi.spyOn(f.page.mouse, "click"),
        vi.spyOn(f.page.mouse, "down"),
        vi.spyOn(f.page.mouse, "up"),
        vi.spyOn(f.page.mouse, "move"),
        vi.spyOn(f.page.mouse, "wheel"),
        vi.spyOn(f.page.keyboard, "press"),
        vi.spyOn(f.page.keyboard, "insertText"),
      ];
      const hits = f.hits.length;
      const result = yield* f.call(f.tabId, operation, input).pipe(Effect.result);
      blocked(result);
      expect(protocol).not.toHaveBeenCalled();
      expect(evaluate).not.toHaveBeenCalled();
      expect(evaluateHandle).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalled();
      expect(locator).not.toHaveBeenCalled();
      for (const command of inputCommands) expect(command).not.toHaveBeenCalled();
      expect(f.hits).toHaveLength(hits);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("status and close remain available after a tab is fenced", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.promise(() => f.page.goto(`${f.blocked}/blocked`));
      yield* Effect.promise(() => f.page.goto(`${f.allowed}/safe`));
      expect((yield* f.call(f.tabId, "status", {}).pipe(Effect.result))._tag).toBe("Success");
      expect((yield* f.call(f.tabId, "close", {}).pipe(Effect.result))._tag).toBe("Success");
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("recordingStop can finish an active recording after a tab is fenced", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      expect((yield* f.call(f.tabId, "recordingStart", {}).pipe(Effect.result))._tag).toBe(
        "Success",
      );
      yield* Effect.promise(() => f.page.goto(`${f.blocked}/blocked`));
      yield* Effect.promise(() => f.page.goto(`${f.allowed}/safe`));
      expect((yield* f.call(f.tabId, "recordingStop", {}).pipe(Effect.result))._tag).toBe(
        "Success",
      );
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("a cut while snapshot waits prevents annotation on the page", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const viewer = yield* f.service.attachViewer({
        threadId,
        tabId: f.tabId,
        canOperate: true,
        maxWidth: 1280,
        maxHeight: 800,
        quality: 70,
      });
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const latch = Promise.withResolvers<void>();
      yield* Effect.forkChild(
        Deferred.await(resume).pipe(Effect.tap(() => Effect.sync(latch.resolve))),
      );
      const original = f.page.ariaSnapshot.bind(f.page);
      vi.spyOn(f.page, "ariaSnapshot").mockImplementation(async (options) => {
        const tree = await original(options);
        Deferred.doneUnsafe(entered, Effect.void);
        await latch.promise;
        return tree;
      });
      const snapshot = yield* f
        .call(f.tabId, "snapshot", { annotate: true, captureImage: true })
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(entered);
      yield* Effect.promise(() => f.page.goto(`${f.blocked}/blocked`));
      const evaluation = vi.spyOn(f.page, "evaluate");
      const taking = yield* viewer.input({ type: "takeControl" }).pipe(Effect.forkChild);
      yield* Deferred.succeed(resume, undefined);
      const result = yield* Fiber.join(snapshot);
      yield* Fiber.join(taking);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({ reason: "blocked_url" });
      expect(
        evaluation.mock.calls.filter(([script]) => String(script).includes("goat-ref-overlay")),
      ).toHaveLength(0);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("a cut while page read waits prevents starting its observer script", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const viewer = yield* f.service.attachViewer({
        threadId,
        tabId: f.tabId,
        canOperate: true,
        maxWidth: 1280,
        maxHeight: 800,
        quality: 70,
      });
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const latch = Promise.withResolvers<void>();
      yield* Effect.forkChild(
        Deferred.await(resume).pipe(Effect.tap(() => Effect.sync(latch.resolve))),
      );
      const context = f.page.context();
      const cookies = context.cookies.bind(context);
      vi.spyOn(context, "cookies").mockImplementation(async (...args) => {
        const values = await cookies(...args);
        Deferred.doneUnsafe(entered, Effect.void);
        await latch.promise;
        return values;
      });
      const body = f.page.locator("body");
      const locator = f.page.locator.bind(f.page);
      vi.spyOn(f.page, "locator").mockImplementation((selector, options) =>
        selector === "body" ? body : locator(selector, options),
      );
      const rendered = vi.spyOn(body, "evaluate");
      const reading = yield* f.call(f.tabId, "read", {}).pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(entered);
      yield* Effect.promise(() => f.page.goto(`${f.blocked}/blocked`));
      const taking = yield* viewer.input({ type: "takeControl" }).pipe(Effect.forkChild);
      yield* Deferred.succeed(resume, undefined);
      const result = yield* Fiber.join(reading);
      yield* Fiber.join(taking);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({ reason: "blocked_url" });
      expect(rendered).not.toHaveBeenCalled();
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("a fence that changes during dialog admission prevents the answer", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const dialogReady = f.page.waitForEvent("dialog");
      const script = f.page.evaluate("confirm('continue?')");
      void script.catch(() => undefined);
      const dialog = yield* Effect.promise(() => dialogReady);
      const accept = vi.spyOn(dialog, "accept");
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const original = Object.getOwnPropertyDescriptor(f.settings, "getSettings");
      if (!original) return yield* Effect.die("missing settings descriptor");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => Object.defineProperty(f.settings, "getSettings", original)),
      );
      const delayed = f.settings.getSettings.pipe(
        Effect.tap(() =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(resume))),
        ),
      );
      Object.defineProperty(f.settings, "getSettings", { ...original, value: delayed });
      const answering = yield* f
        .call(f.tabId, "dialog", { accept: true })
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(entered);
      yield* f.settings.updateSettings({ blockedBrowserHosts: ["localhost", "127.0.0.1"] });
      yield* Deferred.succeed(resume, undefined);
      const result = yield* Fiber.join(answering);
      if (accept.mock.calls.length === 0) yield* Effect.promise(() => dialog.dismiss());
      yield* Effect.promise(() => script);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({ reason: "blocked_url" });
      expect(accept).not.toHaveBeenCalled();
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("a host blocked during navigation admission receives no request", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const descriptor = Object.getOwnPropertyDescriptor(f.settings, "getSettings");
      if (!descriptor) return yield* Effect.die("missing settings descriptor");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => Object.defineProperty(f.settings, "getSettings", descriptor)),
      );
      let calls = 0;
      const delayed = f.settings.getSettings.pipe(
        Effect.tap(() => {
          calls += 1;
          return calls === 3
            ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(resume)))
            : Effect.void;
        }),
      );
      Object.defineProperty(f.settings, "getSettings", { ...descriptor, value: delayed });
      const goto = vi.spyOn(f.page, "goto");
      const navigating = yield* f
        .call(f.tabId, "navigate", { url: `${f.allowed}/after-fence` })
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(entered);
      yield* f.settings.updateSettings({ blockedBrowserHosts: ["localhost", "127.0.0.1"] });
      yield* Deferred.succeed(resume, undefined);
      const result = yield* Fiber.join(navigating);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({ reason: "blocked_url" });
      expect(goto).not.toHaveBeenCalled();
      expect(f.hits.some((hit) => hit.endsWith("/after-fence"))).toBe(false);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("a cut while recording prepares its encoder sends no setup script", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const viewer = yield* f.service.attachViewer({
        threadId,
        tabId: f.tabId,
        canOperate: true,
        maxWidth: 1280,
        maxHeight: 800,
        quality: 70,
      });
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const latch = Promise.withResolvers<void>();
      yield* Effect.forkChild(
        Deferred.await(resume).pipe(Effect.tap(() => Effect.sync(latch.resolve))),
      );
      const original = ServerBrowserContexts.prototype.scratchPage;
      let encoder: import("playwright-core").Page | undefined;
      const spy = vi
        .spyOn(ServerBrowserContexts.prototype, "scratchPage")
        .mockImplementation(async function (this: ServerBrowserContexts) {
          encoder = await original.call(this);
          Deferred.doneUnsafe(entered, Effect.void);
          await latch.promise;
          return encoder;
        });
      yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
      const starting = yield* f
        .call(f.tabId, "recordingStart", {})
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(entered);
      if (!encoder) return yield* Effect.die("missing recording encoder");
      const evaluation = vi.spyOn(encoder, "evaluate");
      yield* Effect.promise(() => f.page.goto(`${f.blocked}/blocked`));
      const taking = yield* viewer.input({ type: "takeControl" }).pipe(Effect.forkChild);
      yield* Deferred.succeed(resume, undefined);
      const result = yield* Fiber.join(starting);
      yield* Fiber.join(taking);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({ reason: "blocked_url" });
      expect(evaluation).not.toHaveBeenCalled();
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("a host blocked during new-tab preparation receives no navigation command", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const latch = Promise.withResolvers<void>();
      yield* Effect.forkChild(
        Deferred.await(resume).pipe(Effect.tap(() => Effect.sync(latch.resolve))),
      );
      const originalContext = ServerBrowserContexts.prototype.contextFor;
      let goto: ReturnType<typeof vi.spyOn> | undefined;
      const contextSpy = vi
        .spyOn(ServerBrowserContexts.prototype, "contextFor")
        .mockImplementation(async function (this: ServerBrowserContexts, ...args) {
          const context = await originalContext.apply(this, args);
          const originalPage = context.newPage.bind(context);
          vi.spyOn(context, "newPage").mockImplementation(async () => {
            const page = await originalPage();
            goto = vi.spyOn(page, "goto");
            const viewport = page.setViewportSize.bind(page);
            vi.spyOn(page, "setViewportSize").mockImplementation(async (size) => {
              await viewport(size);
              Deferred.doneUnsafe(entered, Effect.void);
              await latch.promise;
            });
            return page;
          });
          return context;
        });
      yield* Effect.addFinalizer(() => Effect.sync(() => contextSpy.mockRestore()));
      const opening = yield* f.broker
        .invoke({
          scope,
          operation: "open",
          input: { url: `${f.allowed}/new-fenced`, reuseExistingTab: false, show: false },
        })
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(entered);
      yield* f.settings.updateSettings({ blockedBrowserHosts: ["localhost", "127.0.0.1"] });
      yield* Deferred.succeed(resume, undefined);
      const result = yield* Fiber.join(opening);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({ reason: "blocked_url", dispatched: false });
      expect(goto).toBeDefined();
      expect(goto).not.toHaveBeenCalled();
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("an operation waiting in admission cannot navigate after its run ends", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const descriptor = Object.getOwnPropertyDescriptor(f.settings, "getSettings");
      if (!descriptor) return yield* Effect.die("missing settings descriptor");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => Object.defineProperty(f.settings, "getSettings", descriptor)),
      );
      const delayed = f.settings.getSettings.pipe(
        Effect.tap(() =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(resume))),
        ),
      );
      Object.defineProperty(f.settings, "getSettings", { ...descriptor, value: delayed });
      const navigate = vi.spyOn(f.page, "goto");
      const action = yield* f
        .call(f.tabId, "navigate", { url: `${f.allowed}/after-end` })
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(entered);
      yield* f.end;
      yield* Deferred.succeed(resume, undefined);
      const result = yield* Fiber.join(action);
      expect(result._tag).toBe("Failure");
      expect(navigate).not.toHaveBeenCalled();
      expect(f.hits.some((hit) => hit.endsWith("/after-end"))).toBe(false);
    }),
  ).pipe(Effect.provide(layer)),
);
