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
import { SessionControl } from "./SessionControl.ts";

let browser: Browser | undefined;
const contexts: BrowserContext[] = [];
let shareNextContext = false;
let afterSecretReply: (() => Promise<void>) | undefined;
let interceptSecretReply = false;
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
      const create = context.newCDPSession.bind(context);
      if (interceptSecretReply)
        vi.spyOn(context, "newCDPSession").mockImplementation(async (target) => {
          const cdp = await create(target);
          const send = cdp.send.bind(cdp);
          vi.spyOn(cdp, "send").mockImplementation((...args) => {
            const result: ReturnType<typeof send> = Reflect.apply(send, cdp, args);
            if (
              args[0] !== "Runtime.callFunctionOn" ||
              args[1] === undefined ||
              !("functionDeclaration" in args[1]) ||
              !args[1].functionDeclaration.startsWith(
                "function (value, origin, identifier, account)",
              )
            )
              return result;
            return result.then(async (value) => {
              await afterSecretReply?.();
              return value;
            });
          });
          return cdp;
        });
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
      Layer.mock(SecretRequests.SecretRequests)({
        consumeForOrigin: () => Effect.succeed("synthetic-password"),
      }),
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
  const manager = yield* Manager.PreviewManager;
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
    manager,
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

const popupSetup = Effect.gen(function* () {
  const f = yield* fixture;
  const context = f.page.context();
  const create = context.newCDPSession.bind(context);
  const sent: string[] = [];
  const hook: { beforeReturn?: (target: unknown) => Promise<void> } = {};
  const install = vi.spyOn(context, "newCDPSession").mockImplementation(async (target) => {
    const cdp = await create(target);
    if (target !== f.page) {
      const send = cdp.send.bind(cdp);
      vi.spyOn(cdp, "send").mockImplementation((...args) => {
        sent.push(args[0]);
        return Reflect.apply(send, cdp, args);
      });
    }
    await hook.beforeReturn?.(target);
    return cdp;
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => install.mockRestore()));
  return { ...f, sent, hook };
});

it.effect("a blocked agent popup closes without setup and is not adopted", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* popupSetup;
      const popupReady = f.page.waitForEvent("popup");
      const result = yield* f.call(f.tabId, "click", { locator: "#popup" }).pipe(Effect.result);
      const popup = yield* Effect.promise(() => popupReady);
      const closeEvent = yield* Deferred.make<void>();
      if (popup.isClosed()) yield* Deferred.succeed(closeEvent, undefined);
      else popup.once("close", () => Deferred.doneUnsafe(closeEvent, Effect.void));
      const closed = Deferred.await(closeEvent).pipe(Effect.as("closed"));
      const adopted = Stream.merge(Stream.succeed(undefined), f.service.sessionChanges).pipe(
        Stream.mapEffect(() => f.service.sessions),
        Stream.filter((views) => views.some((view) => view.tabId !== f.tabId)),
        Stream.runHead,
        Effect.as("adopted"),
      );
      expect(yield* Effect.raceFirst(closed, adopted)).toBe("closed");
      expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "blocked_url" } });
      expect(f.sent).not.toContain("Page.addScriptToEvaluateOnNewDocument");
      expect(f.sent).not.toContain("Fetch.enable");
      expect(f.sent).not.toContain("Page.enable");
      expect(f.sent).not.toContain("Target.setDiscoverTargets");
      expect(f.sent.filter((method) => method !== "Target.getTargetInfo")).toEqual([]);
      expect((yield* f.service.sessions).map((tab) => tab.tabId)).toEqual([f.tabId]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("an allowed popup receives clipboard instrumentation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* popupSetup;
      const popupReady = f.page.waitForEvent("popup");
      yield* Effect.promise(() =>
        f.page.locator("#next").evaluate((button, url) => {
          button.setAttribute("onclick", `window.open('${url}')`);
        }, `${f.allowed}/safe`),
      );
      yield* f.call(f.tabId, "click", { locator: "#next" });
      const popup = yield* Effect.promise(() => popupReady);
      yield* Stream.merge(Stream.succeed(undefined), f.service.sessionChanges).pipe(
        Stream.mapEffect(() => f.service.sessions),
        Stream.filter((views) => views.some((view) => view.tabId !== f.tabId)),
        Stream.runHead,
      );
      expect(f.sent).toContain("Page.addScriptToEvaluateOnNewDocument");
      yield* f.end;
      expect(yield* Effect.promise(() => popup.evaluate(() => 1))).toBe(1);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("a person's blocked popup is adopted and fenced for the agent", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* popupSetup;
      const viewer = yield* f.service.attachViewer({
        threadId,
        tabId: f.tabId,
        canOperate: true,
        maxWidth: 1280,
        maxHeight: 800,
        quality: 70,
      });
      yield* viewer.input({ type: "takeControl" });
      const popupReady = f.page.waitForEvent("popup");
      yield* Effect.promise(() =>
        f.page.evaluate(`window.open(${JSON.stringify(`${f.blocked}/blocked`)})`),
      );
      const popup = yield* Effect.promise(() => popupReady);
      yield* Effect.promise(() => popup.waitForURL(`${f.blocked}/blocked`));
      const found = yield* Stream.merge(Stream.succeed(undefined), f.service.sessionChanges).pipe(
        Stream.mapEffect(() => f.service.sessions),
        Stream.filter((views) => views.some((view) => view.tabId !== f.tabId)),
        Stream.runHead,
      );
      if (found._tag === "None") return yield* Effect.die("popup not adopted");
      const tabId = PreviewTabId.make(found.value.find((tab) => tab.tabId !== f.tabId)!.tabId);
      yield* Effect.promise(() => popup.goto(`${f.allowed}/safe`));
      expect(yield* f.call(tabId, "press", { key: "Enter" }).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { reason: "blocked_url" },
      });
      expect(f.sent).toContain("Page.addScriptToEvaluateOnNewDocument");
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("a cut while popup setup waits closes it without sending setup commands", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* popupSetup;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const latch = Promise.withResolvers<void>();
      yield* Deferred.await(release).pipe(
        Effect.tap(() => Effect.sync(latch.resolve)),
        Effect.forkChild,
      );
      let popupSessions = 0;
      f.hook.beforeReturn = async (target) => {
        if (target !== f.page && ++popupSessions === 2) {
          Deferred.doneUnsafe(entered, Effect.void);
          await latch.promise;
        }
      };
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          latch.resolve();
          delete f.hook.beforeReturn;
        }),
      );
      yield* Effect.promise(() =>
        f.page.locator("#next").evaluate((button, url) => {
          button.setAttribute("onclick", `window.open('${url}')`);
        }, `${f.allowed}/safe`),
      );
      const popupReady = f.page.waitForEvent("popup");
      const clicking = yield* f
        .call(f.tabId, "click", { locator: "#next" })
        .pipe(Effect.result, Effect.forkChild);
      const popup = yield* Effect.promise(() => popupReady);
      yield* Deferred.await(entered);
      yield* Effect.promise(() => f.page.goto(`${f.blocked}/blocked`));
      if (!popup.isClosed()) yield* Effect.promise(() => popup.waitForEvent("close"));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(clicking);
      expect(f.sent).not.toContain("Page.addScriptToEvaluateOnNewDocument");
      expect(f.sent).not.toContain("Fetch.enable");
      expect(f.sent).not.toContain("Page.enable");
      expect(f.sent.filter((method) => method !== "Target.getTargetInfo")).toEqual([]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("a new current run closes an older popup while setup waits", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* popupSetup;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const latch = Promise.withResolvers<void>();
      yield* Deferred.await(release).pipe(
        Effect.tap(() => Effect.sync(latch.resolve)),
        Effect.forkChild,
      );
      let popupSessions = 0;
      f.hook.beforeReturn = async (target) => {
        if (target !== f.page && ++popupSessions === 2) {
          Deferred.doneUnsafe(entered, Effect.void);
          await latch.promise;
        }
      };
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          latch.resolve();
          delete f.hook.beforeReturn;
        }),
      );
      yield* Effect.promise(() =>
        f.page.locator("#next").evaluate((button, url) => {
          button.setAttribute("onclick", `window.open('${url}')`);
        }, `${f.allowed}/safe`),
      );
      const popupReady = f.page.waitForEvent("popup");
      const clicking = yield* f
        .call(f.tabId, "click", { locator: "#next" })
        .pipe(Effect.result, Effect.forkChild);
      const popup = yield* Effect.promise(() => popupReady);
      yield* Deferred.await(entered);
      const activity = yield* PreviewAgentActivity.PreviewAgentActivity;
      const endLater = yield* activity.begin(threadId, "later-run");
      yield* Effect.addFinalizer(() => endLater);
      if (!popup.isClosed()) yield* Effect.promise(() => popup.waitForEvent("close"));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(clicking);
      expect(f.sent).not.toContain("Page.addScriptToEvaluateOnNewDocument");
      expect(f.sent).not.toContain("Fetch.enable");
      expect(f.sent).not.toContain("Page.enable");
      expect(f.sent.filter((method) => method !== "Target.getTargetInfo")).toEqual([]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect(
  "a blank popup's blocked navigation observes the request or closure and fences its opener",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* Effect.promise(() =>
          f.page.locator("#popupBlank").evaluate((button, url) => {
            button.setAttribute(
              "onclick",
              `const p=window.open('about:blank');p.location.href='${url}'`,
            );
          }, `${f.blocked}/slow`),
        );
        const requestObserved = yield* Deferred.make<void>();
        const onRequest = (request: import("playwright-core").Request) => {
          if (request.isNavigationRequest() && request.url() === `${f.blocked}/slow`)
            Deferred.doneUnsafe(requestObserved, Effect.void);
        };
        f.page.context().on("request", onRequest);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => f.page.context().off("request", onRequest)),
        );
        const closed = yield* Deferred.make<string>();
        const monitor = yield* Effect.acquireRelease(
          Effect.promise(() => f.page.context().newCDPSession(f.page)),
          (session) => Effect.promise(() => session.detach().catch(() => undefined)),
        );
        const root = yield* Effect.promise(() => monitor.send("Target.getTargetInfo"));
        let popupTarget: string | undefined;
        monitor.on("Target.targetCreated", ({ targetInfo }) => {
          if (targetInfo.openerId === root.targetInfo.targetId) popupTarget = targetInfo.targetId;
        });
        monitor.on("Target.targetDestroyed", ({ targetId }) => {
          if (targetId === popupTarget) Deferred.doneUnsafe(closed, Effect.succeed(targetId));
        });
        yield* Effect.promise(() => monitor.send("Target.setDiscoverTargets", { discover: true }));
        const clicking = yield* f
          .call(f.tabId, "click", { locator: "#popupBlank" })
          .pipe(Effect.result, Effect.forkChild);
        const first = yield* Effect.raceFirst(
          Deferred.await(requestObserved).pipe(Effect.as("request" as const)),
          Deferred.await(closed).pipe(Effect.map((targetId) => ({ targetId }))),
        );
        yield* Deferred.succeed(f.slowGate, undefined);
        yield* Fiber.join(clicking);
        if (first !== "request") expect(first.targetId).toBe(popupTarget);
        expect(yield* f.call(f.tabId, "press", { key: "Enter" }).pipe(Effect.result)).toMatchObject(
          { _tag: "Failure", failure: { reason: "blocked_url" } },
        );
      }),
    ).pipe(Effect.provide(layer)),
);

it.effect("a person's adopted blank popup fences both tabs after a blocked visit", () =>
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
      const events = yield* f.manager.subscribeEvents;
      const popupReady = f.page.waitForEvent("popup");
      yield* Effect.promise(() => f.page.evaluate("window.open('about:blank')"));
      const popup = yield* Effect.promise(() => popupReady);
      const opened = yield* Stream.fromSubscription(events).pipe(
        Stream.filter(
          (event) =>
            event.type === "opened" && event.threadId === threadId && event.tabId !== f.tabId,
        ),
        Stream.runHead,
      );
      if (opened._tag === "None") return yield* Effect.die("popup event stream ended");
      const tabId = PreviewTabId.make(opened.value.tabId);
      yield* f.call(tabId, "claim", {});
      yield* Effect.promise(() => popup.goto(`${f.blocked}/blocked`));
      yield* Effect.promise(() => popup.goto(`${f.allowed}/safe`));
      yield* viewer.input({ type: "releaseControl" });
      expect(yield* f.call(tabId, "press", { key: "Enter" }).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { reason: "blocked_url" },
      });
      expect(yield* f.call(f.tabId, "press", { key: "Enter" }).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { reason: "blocked_url" },
      });
    }),
  ).pipe(Effect.provide(layer)),
);

const delayedPopup = (startLaterRun: boolean, endOriginal = true) =>
  Effect.gen(function* () {
    const f = yield* popupSetup;
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    yield* Effect.addFinalizer(() => Effect.sync(() => now.mockRestore()));
    const trigger = yield* Deferred.make<void>();
    const latch = Promise.withResolvers<void>();
    yield* Deferred.await(trigger).pipe(
      Effect.tap(() => Effect.sync(latch.resolve)),
      Effect.forkScoped,
    );
    yield* Effect.addFinalizer(() => Effect.sync(latch.resolve));
    yield* Effect.promise(() => f.page.exposeFunction("delayedPopupGate", () => latch.promise));
    yield* Effect.promise(() =>
      f.page.locator("#next").evaluate((button) => {
        button.setAttribute(
          "onclick",
          "void globalThis.delayedPopupGate().then(() => window.open('about:blank'))",
        );
      }),
    );
    yield* f.call(f.tabId, "click", { locator: "#next" });
    if (endOriginal) yield* f.end;
    if (startLaterRun) {
      const activity = yield* PreviewAgentActivity.PreviewAgentActivity;
      const end = yield* activity.begin(threadId, "later-run");
      yield* Effect.addFinalizer(() => end);
    }
    now.mockReturnValue(5_000);
    const popupReady = f.page.waitForEvent("popup");
    yield* Deferred.succeed(trigger, undefined);
    const popup = yield* Effect.promise(() => popupReady);
    const closed = yield* Deferred.make<void>();
    if (popup.isClosed()) yield* Deferred.succeed(closed, undefined);
    else popup.once("close", () => Deferred.doneUnsafe(closed, Effect.void));
    const adopted = Stream.merge(Stream.succeed(undefined), f.service.sessionChanges).pipe(
      Stream.mapEffect(() => f.manager.list({ threadId })),
      Stream.filter((result) => result.sessions.some((view) => view.tabId !== f.tabId)),
      Stream.runHead,
      Effect.as("adopted"),
    );
    expect(yield* Effect.raceFirst(Deferred.await(closed).pipe(Effect.as("closed")), adopted)).toBe(
      "closed",
    );
    expect(f.sent.filter((method) => method !== "Target.getTargetInfo")).toEqual([]);
  });

it.effect("a delayed agent popup closes without setup after its originating run ends", () =>
  Effect.scoped(delayedPopup(false)).pipe(Effect.provide(layer)),
);

it.effect("a delayed popup from an ended run closes while a later run is active", () =>
  Effect.scoped(delayedPopup(true)).pipe(Effect.provide(layer)),
);

it.effect(
  "a delayed popup closes when a later run is current even if its original run is still active",
  () => Effect.scoped(delayedPopup(true, false)).pipe(Effect.provide(layer)),
);

it.effect("a person's unattributed blocked popup fences all active tabs in its context", () =>
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
      const observed = yield* Deferred.make<void>();
      const cut = SessionControl.prototype.cutBlockedUrl;
      const cutTabs = new Set<SessionControl>();
      const spy = vi.spyOn(SessionControl.prototype, "cutBlockedUrl").mockImplementation(function (
        this: SessionControl,
      ) {
        cut.call(this);
        cutTabs.add(this);
        if (cutTabs.size === 2) Deferred.doneUnsafe(observed, Effect.void);
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
      const opening = yield* Effect.promise(() =>
        f.page.evaluate(`window.open(${JSON.stringify(`${f.blocked}/slow`)})`),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(f.slowStarted);
      yield* Deferred.await(observed);
      const first = yield* f.call(f.tabId, "press", { key: "Enter" }).pipe(Effect.result);
      const second = yield* f.call(other, "press", { key: "Enter" }).pipe(Effect.result);
      yield* Deferred.succeed(f.slowGate, undefined);
      yield* Fiber.join(opening);
      expect(first).toMatchObject({
        _tag: "Failure",
        failure: { reason: "blocked_url", dispatched: false },
      });
      expect(second).toMatchObject({
        _tag: "Failure",
        failure: { reason: "blocked_url", dispatched: false },
      });
    }),
  ).pipe(Effect.provide(layer)),
);

const secretPopup = (timing: "during" | "after" | "takeover") =>
  Effect.scoped(
    Effect.gen(function* () {
      interceptSecretReply = true;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          interceptSecretReply = false;
        }),
      );
      const f = yield* fixture;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const latch = Promise.withResolvers<void>();
      yield* Deferred.await(release).pipe(
        Effect.tap(() => Effect.sync(latch.resolve)),
        Effect.forkScoped,
      );
      afterSecretReply = async () => {
        Deferred.doneUnsafe(entered, Effect.void);
        await latch.promise;
      };
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          afterSecretReply = undefined;
          latch.resolve();
        }),
      );
      yield* Effect.promise(() =>
        f.page.evaluate(
          `document.body.innerHTML = '<input id="pw" type="password">'; ${
            timing === "during"
              ? `document.querySelector('#pw').addEventListener('input', () => window.open('about:blank'));`
              : ""
          }`,
        ),
      );
      const viewer = yield* f.service.attachViewer({
        threadId,
        tabId: f.tabId,
        canOperate: true,
        maxWidth: 1280,
        maxHeight: 800,
        quality: 70,
      });
      const popupReady = f.page.waitForEvent("popup");
      const filling = yield* f
        .call(f.tabId, "fillSecret", {
          secretRef: "secret-ref:12345678901234567890123456789012",
          selector: "#pw",
        })
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(entered);
      if (timing === "takeover") {
        const taken = yield* Deferred.make<void>();
        const handed = yield* Deferred.make<void>();
        const take = SessionControl.prototype.take;
        const releaseOwner = SessionControl.prototype.release;
        const takeSpy = vi.spyOn(SessionControl.prototype, "take").mockImplementation(function (
          this: SessionControl,
          ...args
        ) {
          const work = Reflect.apply(take, this, args);
          Deferred.doneUnsafe(taken, Effect.void);
          return work;
        });
        const releaseSpy = vi
          .spyOn(SessionControl.prototype, "release")
          .mockImplementation(function (this: SessionControl, ...args) {
            const work = Reflect.apply(releaseOwner, this, args);
            Deferred.doneUnsafe(handed, Effect.void);
            return work;
          });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            takeSpy.mockRestore();
            releaseSpy.mockRestore();
          }),
        );
        const taking = yield* viewer.input({ type: "takeControl" }).pipe(Effect.forkChild);
        yield* Deferred.await(taken);
        const handing = yield* viewer.input({ type: "releaseControl" }).pipe(Effect.forkChild);
        yield* Deferred.await(handed);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(filling);
        yield* Fiber.join(taking);
        yield* Fiber.join(handing);
        yield* Effect.promise(() => f.page.evaluate("window.open('about:blank')"));
        const popup = yield* Effect.promise(() => popupReady);
        if (!popup.isClosed()) yield* Effect.promise(() => popup.waitForEvent("close"));
        expect((yield* f.service.sessions).map((tab) => tab.tabId)).toEqual([f.tabId]);
        return;
      }
      if (timing === "after") {
        yield* Deferred.succeed(release, undefined);
        expect((yield* Fiber.join(filling))._tag).toBe("Success");
        yield* Effect.promise(() => f.page.evaluate("window.open('about:blank')"));
      }
      const popup = yield* Effect.promise(() => popupReady);
      const adopted = yield* Stream.merge(Stream.succeed(undefined), f.service.sessionChanges).pipe(
        Stream.mapEffect(() => f.service.sessions),
        Stream.filter((tabs) => tabs.some((tab) => tab.tabId !== f.tabId)),
        Stream.runHead,
      );
      expect(adopted._tag).toBe("Some");
      if (timing === "during") {
        yield* Deferred.succeed(release, undefined);
        expect((yield* Fiber.join(filling))._tag).toBe("Success");
      }
      yield* Effect.promise(() => f.page.goto(`${f.blocked}/blocked`));
      if (!popup.isClosed()) yield* Effect.promise(() => popup.waitForEvent("close"));
    }),
  );

it.effect("a takeover during secret fill leaves a later popup unlinked and closed", () =>
  secretPopup("takeover").pipe(Effect.provide(layer)),
);
it.effect("a popup opened during secret fill is adopted and closes when the tab is cut", () =>
  secretPopup("during").pipe(Effect.provide(layer)),
);
it.effect("a popup opened just after secret fill is adopted and closes when the tab is cut", () =>
  secretPopup("after").pipe(Effect.provide(layer)),
);

it.effect("a takeover before a secret popup response prevents agent adoption", () =>
  Effect.scoped(
    Effect.gen(function* () {
      interceptSecretReply = true;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          interceptSecretReply = false;
          afterSecretReply = undefined;
        }),
      );
      const f = yield* fixture;
      const filled = yield* Deferred.make<void>();
      const created = yield* Deferred.make<void>();
      const reply = Promise.withResolvers<void>();
      const response = Promise.withResolvers<void>();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          reply.resolve();
          response.resolve();
        }),
      );
      afterSecretReply = async () => {
        Deferred.doneUnsafe(filled, Effect.void);
        await reply.promise;
      };
      yield* Effect.promise(() =>
        f.page.context().route("https://safe.test/delayed", async (route) => {
          await response.promise;
          await route.fulfill({ body: "popup", contentType: "text/html" });
        }),
      );
      const monitor = yield* Effect.promise(() => f.page.context().newCDPSession(f.page));
      const root = yield* Effect.promise(() => monitor.send("Target.getTargetInfo"));
      monitor.on("Target.targetCreated", ({ targetInfo }) => {
        if (targetInfo.openerId === root.targetInfo.targetId)
          Deferred.doneUnsafe(created, Effect.void);
      });
      yield* Effect.promise(() => monitor.send("Target.setDiscoverTargets", { discover: true }));
      yield* Effect.promise(() =>
        f.page.evaluate(
          `document.body.innerHTML='<input type="password" id="pw">';document.querySelector('#pw').addEventListener('input',()=>window.open('https://safe.test/delayed'));`,
        ),
      );
      const viewer = yield* f.service.attachViewer({
        threadId,
        tabId: f.tabId,
        canOperate: true,
        maxWidth: 1280,
        maxHeight: 800,
        quality: 70,
      });
      const popupReady = f.page.waitForEvent("popup");
      const filling = yield* f
        .call(f.tabId, "fillSecret", {
          secretRef: "secret-ref:12345678901234567890123456789012",
          selector: "#pw",
        })
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(created);
      yield* Deferred.await(filled);
      const taken = yield* Deferred.make<void>();
      const handed = yield* Deferred.make<void>();
      const take = SessionControl.prototype.take,
        hand = SessionControl.prototype.release;
      const takeSpy = vi.spyOn(SessionControl.prototype, "take").mockImplementation(function (
        this: SessionControl,
        ...args
      ) {
        const result = Reflect.apply(take, this, args);
        Deferred.doneUnsafe(taken, Effect.void);
        return result;
      });
      const handSpy = vi.spyOn(SessionControl.prototype, "release").mockImplementation(function (
        this: SessionControl,
        ...args
      ) {
        const result = Reflect.apply(hand, this, args);
        Deferred.doneUnsafe(handed, Effect.void);
        return result;
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          takeSpy.mockRestore();
          handSpy.mockRestore();
        }),
      );
      const taking = yield* viewer
        .input({ type: "takeControl" })
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(taken);
      const handing = yield* viewer
        .input({ type: "releaseControl" })
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(handed);
      reply.resolve();
      yield* Fiber.join(filling);
      yield* Fiber.join(taking);
      yield* Fiber.join(handing);
      response.resolve();
      const popup = yield* Effect.promise(() => popupReady);
      const close = yield* Deferred.make<void>();
      if (popup.isClosed()) yield* Deferred.succeed(close, undefined);
      else popup.once("close", () => Deferred.doneUnsafe(close, Effect.void));
      const adopted = Stream.merge(Stream.succeed(undefined), f.service.sessionChanges).pipe(
        Stream.mapEffect(() => f.service.sessions),
        Stream.filter((tabs) => tabs.some((tab) => tab.tabId !== f.tabId)),
        Stream.runHead,
        Effect.as("adopted"),
      );
      const result = yield* Effect.raceFirst(
        Deferred.await(close).pipe(Effect.as("closed")),
        adopted,
      );
      expect(result).toBe("closed");
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("a takeover while popup setup waits closes it before instrumentation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* popupSetup;
      const entered = yield* Deferred.make<void>();
      const taken = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const latch = Promise.withResolvers<void>();
      yield* Deferred.await(release).pipe(
        Effect.tap(() => Effect.sync(latch.resolve)),
        Effect.forkScoped,
      );
      let popupSessions = 0;
      f.hook.beforeReturn = async (target) => {
        if (target !== f.page && ++popupSessions === 2) {
          Deferred.doneUnsafe(entered, Effect.void);
          await latch.promise;
        }
      };
      const take = SessionControl.prototype.take;
      const spy = vi.spyOn(SessionControl.prototype, "take").mockImplementation(function (
        this: SessionControl,
        ...args
      ) {
        const work = Reflect.apply(take, this, args);
        Deferred.doneUnsafe(taken, Effect.void);
        return work;
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          spy.mockRestore();
          latch.resolve();
          delete f.hook.beforeReturn;
        }),
      );
      const viewer = yield* f.service.attachViewer({
        threadId,
        tabId: f.tabId,
        canOperate: true,
        maxWidth: 1280,
        maxHeight: 800,
        quality: 70,
      });
      yield* Effect.promise(() =>
        f.page
          .locator("#next")
          .evaluate(
            (button, url) => button.setAttribute("onclick", `window.open('${url}')`),
            `${f.allowed}/safe`,
          ),
      );
      const popupReady = f.page.waitForEvent("popup");
      const clicking = yield* f
        .call(f.tabId, "click", { locator: "#next" })
        .pipe(Effect.result, Effect.forkChild);
      const popup = yield* Effect.promise(() => popupReady);
      yield* Deferred.await(entered);
      const taking = yield* viewer
        .input({ type: "takeControl" })
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(taken);
      if (!popup.isClosed()) yield* Effect.promise(() => popup.waitForEvent("close"));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(clicking);
      yield* Fiber.join(taking);
      expect(f.sent).not.toContain("Page.addScriptToEvaluateOnNewDocument");
      expect(f.sent).not.toContain("Fetch.enable");
    }),
  ).pipe(Effect.provide(layer)),
);
