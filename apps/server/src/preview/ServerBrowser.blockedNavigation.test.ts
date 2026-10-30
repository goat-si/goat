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
vi.mock("./ServerBrowserContexts.ts", () => ({
  presentAsChrome: async () => {},
  ServerBrowserContexts: class {
    async contextFor() {
      browser ??= await chromium.launch({ headless: true });
      const context = await browser.newContext();
      contexts.push(context);
      return context;
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
  const server = yield* Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<NodeHttp.Server>((resolve) => {
          const server = NodeHttp.createServer((req, res) => {
            const port = (server.address() as { port: number }).port;
            const blocked = `http://localhost:${port}`;
            const allowed = `http://127.0.0.1:${port}`;
            hits.push(`${req.headers.host}${req.url}`);
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
              `<a id="link" href="${blocked}/blocked">go</a><button id="popup" onclick="window.open('${blocked}/blocked')">popup</button><button id="popupRedirect" onclick="window.open('${allowed}/redirect')">redirect popup</button><form action="${blocked}/blocked"><button id="form">submit</button></form><button id="script" onclick="location.href='${blocked}/blocked'">script</button><button id="popupBlank" onclick="const p=window.open('about:blank');p.location.href='${blocked}/blocked'">blank popup</button><button id="next">next</button>`,
            );
          });
          server.listen(0, () => resolve(server));
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
  return { service, broker, page, tabId, allowed, blocked, hits, end, call };
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
      expect((yield* f.call(f.tabId, "press", { key: "Enter" }).pipe(Effect.result))._tag).toBe(
        "Success",
      );
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
