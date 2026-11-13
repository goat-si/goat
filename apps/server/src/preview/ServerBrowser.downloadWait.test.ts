import * as SqlitePersistence from "../persistence/Sqlite.ts";
// @effect-diagnostics nodeBuiltinImport:off - local HTTP fixture and the saved file Chromium wrote.
import * as NodeHttp from "node:http";
import * as NodeFSP from "node:fs/promises";
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

const threadId = ThreadId.make("download-wait-thread");
const scope = {
  environmentId: EnvironmentId.make("download-wait-env"),
  thread: {
    threadId,
    providerSessionId: "agent-a",
    providerInstanceId: ProviderInstanceId.make("codex"),
    runId: RunId.make("run"),
  },
  client: undefined,
  requestNamespace: "download-wait-test",
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
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "goat-download-wait-" })),
      Layer.provideMerge(NodeServices.layer),
    ),
  ),
);

/** A page whose links download small CSV files, served from 127.0.0.1. */
const filesServer = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<NodeHttp.Server>((resolve) => {
        const server = NodeHttp.createServer((req, res) => {
          const name = /^\/files\/([\w.]+)$/.exec(req.url ?? "")?.[1];
          if (name === undefined) {
            res.writeHead(200, { "content-type": "text/html" });
            res.end('<a id="a" href="/files/a.csv">a</a> <a id="b" href="/files/b.csv">b</a>');
            return;
          }
          res.writeHead(200, {
            "content-type": "text/csv",
            "content-disposition": `attachment; filename="${name}"`,
          });
          res.end(name === "a.csv" ? "1,2" : "3,4,5");
        });
        server.listen(0, "127.0.0.1", () => resolve(server));
      }),
  ),
  (server) => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
);

interface WaitResult {
  readonly download?: {
    readonly fileName: string;
    readonly path: string;
    readonly sizeBytes: number;
  };
}

it.effect(
  "a download wait returns the file the last click saved, and the next wait the next one",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* filesServer;
        const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const broker = yield* Broker.PreviewAutomationBroker;
        const activity = yield* PreviewAgentActivity.PreviewAgentActivity;
        const end = yield* activity.begin(threadId, "run");
        yield* Effect.addFinalizer(() => end);
        // The server browser registers with the broker as its layer starts, as in the other suites.
        yield* ServerBrowser.ServerBrowser;
        yield* Effect.yieldNow;
        const opened = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          operation: "open",
          input: { url: `${origin}/`, reuseExistingTab: false, show: false },
        });
        const tabId = PreviewTabId.make(opened.tabId!);
        const call = <A>(
          operation: Broker.PreviewAutomationInvokeInput["operation"],
          input: unknown,
        ) => broker.invoke<A>({ scope, tabId, operation, input });

        yield* call("click", { locator: "#a" });
        const first = yield* call<WaitResult>("waitFor", { download: true, timeoutMs: 10_000 });
        expect(first.download).toMatchObject({ fileName: "a.csv", sizeBytes: 3 });
        expect(yield* Effect.promise(() => NodeFSP.readFile(first.download!.path, "utf8"))).toBe(
          "1,2",
        );

        yield* call("click", { locator: "#b" });
        const second = yield* call<WaitResult>("waitFor", { download: true, timeoutMs: 10_000 });
        expect(second.download).toMatchObject({ fileName: "b.csv", sizeBytes: 5 });
      }),
    ).pipe(Effect.provide(layer)),
);
