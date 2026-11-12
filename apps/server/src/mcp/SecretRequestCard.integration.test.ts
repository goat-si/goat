import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as Handoffs from "../handoffs/Handoffs.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Worker from "../orchestration-v2/EffectWorker.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Registry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { makeFakeCloudAdapter } from "../orchestration-v2/testkit/FakeCloudAdapter.ts";
import * as Harness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import type { McpThreadInvocationScope } from "./McpInvocationContext.ts";
import { makeRequestSecret } from "./SecretRequestTool.ts";

import * as NodeURL from "node:url";
import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { vi } from "vite-plus/test";
import { McpSchema, McpServer } from "effect/ai";
import { PreviewTabId, type PreviewAutomationStatus } from "@goat/contracts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Broker from "./PreviewAutomationBroker.ts";
import * as DesktopChannel from "../preview/DesktopBrowserChannel.ts";
import * as Manager from "../preview/Manager.ts";
import * as PreviewAgentActivity from "../preview/PreviewAgentActivity.ts";
import * as PreviewBrowser from "../preview/PreviewBrowser.ts";
import { unusedPreviewBrowser } from "../preview/PreviewBrowser.testkit.ts";
import * as ServerBrowser from "../preview/ServerBrowser.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { layerPermissionProfilesOff } from "./McpToolAccess.testkit.ts";
import * as SiteNotes from "../preview/SiteNotes.ts";
import * as PreviewHandlers from "./toolkits/preview/handlers.ts";
import { PreviewStandardToolkit } from "./toolkits/preview/tools.ts";
import { makePreviewTargetHost } from "../screenCode/PreviewTargetHost.ts";
import { createScreenDispatchRouter } from "../screenCode/ScreenDispatchRouter.ts";
import { ScreenRunService } from "../screenCode/ScreenRunService.ts";
import { resolveScreenRuntimeAsset } from "../screenCode/ScreenRuntimeAsset.ts";

const fault = vi.hoisted(() => ({ afterNumber: undefined as undefined | (() => Promise<void>) }));
vi.mock(import("../preview/ServerBrowserCardFill.ts"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    fillCard: (input: Parameters<typeof actual.fillCard>[0]) =>
      actual.fillCard({
        ...input,
        send: async (method, params, onDispatch) => {
          const result = await input.send(method, params, onDispatch);
          const args = Array.isArray(params.arguments)
            ? (params.arguments as Array<{ value?: unknown }>)
            : [];
          if (
            fault.afterNumber &&
            method === "Runtime.callFunctionOn" &&
            typeof params.functionDeclaration === "string" &&
            params.functionDeclaration.includes("GOAT_CARD_MUTATE") &&
            args[0]?.value === "number"
          )
            await fault.afterNumber();
          return result;
        },
      }),
  };
});

let browser: Promise<Browser> | undefined;
const contexts: Array<BrowserContext> = [];
vi.mock("../preview/ServerBrowserContexts.ts", () => ({
  presentAsChrome: async () => {},
  ServerBrowserContexts: class {
    async contextFor() {
      browser ??= chromium.launch({ headless: true });
      const context = await (await browser).newContext();
      await context.route("**/*", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<form><input id="number" autocomplete="cc-number"><select id="month" autocomplete="cc-exp-month"><option value="01">01</option></select><select id="year" autocomplete="cc-exp-year"><option value="2029">2029</option></select><input id="cvc" autocomplete="cc-csc"><input id="name" autocomplete="cc-name"></form><p id="echo"></p><script>for(const field of document.querySelectorAll('input')) field.addEventListener('input', () => { document.querySelector('#echo').textContent += field.value; console.log('echo ' + field.value); });</script>`,
        }),
      );
      contexts.push(context);
      return context;
    }
    async close() {
      for (const context of contexts.splice(0)) await context.close();
      const launched = browser;
      browser = undefined;
      await (await launched)?.close();
    }
  },
}));
const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "card-sentinel", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "card-sentinel", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const threadId = ThreadId.make("thread:card-sentinel");
const instanceId = ProviderInstanceId.make("codex");
const sessionId = AuthSessionId.make("session:card-sentinel");
const number = "4242424242424242";
const cvc = "731";
const cvcLeak = /(^|[^0-9A-Za-z])731([^0-9A-Za-z]|$)/;

it("detects CVC leaks as standalone values without matching identifiers", () => {
  expect(cvcLeak.test("echo 731")).toBe(true);
  expect(cvcLeak.test(JSON.stringify({ cvc: "731" }))).toBe(true);
  expect(cvcLeak.test("a731b")).toBe(false);
});
const name = "CARD_NAME_SENTINEL_8394";
const answer = {
  type: "save_card" as const,
  number,
  expiryMonth: "01",
  expiryYear: "2029",
  cvc,
  name,
};
const scope: McpThreadInvocationScope = {
  environmentId: EnvironmentId.make("test"),
  requestNamespace: "card-sentinel",
  reauthorize: () => Effect.void,
  issuedAt: 0,
  capabilities: new Set(["orchestration", "preview"]),
  client: undefined,
  thread: { threadId, providerSessionId: "session", providerInstanceId: instanceId },
};

it.live("card sentinels stay out of agent results, thread events and browser diagnostics", () => {
  const capturedLogs: string[] = [];
  const logger = Logger.layer(
    [
      Logger.map(Logger.formatJson, (entry) => {
        capturedLogs.push(entry);
      }),
    ],
    { mergeWithExisting: false },
  );
  return Effect.scoped(
    Effect.gen(function* () {
      const fake = yield* makeFakeCloudAdapter(true, instanceId);
      const adapter = {
        ...fake.adapter,
        getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
        openSession: (session: Parameters<typeof fake.adapter.openSession>[0]) =>
          fake.adapter
            .openSession(session)
            .pipe(Effect.map((opened) => ({ ...opened, startTurn: () => Effect.void }))),
      };
      const database = Sqlite.layerMemory;
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* Worker.OrchestrationEffectWorkerV2;
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("sentinel-create"),
          threadId,
          projectId: ProjectId.make("project:sentinel"),
          title: "Login",
          modelSelection: { instanceId, model: "fake" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("sentinel-run"),
          threadId,
          messageId: MessageId.make("message:sentinel"),
          text: "Sign in",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        const threadService = yield* ThreadManagement.ThreadManagementService;
        const threads = Layer.succeed(ThreadManagement.ThreadManagementService, threadService);
        const stored = new Map<string, Uint8Array>();
        const store = Layer.succeed(
          SecretStore.ServerSecretStore,
          SecretStore.ServerSecretStore.of({
            get: (name) => Effect.sync(() => Option.fromNullishOr(stored.get(name))),
            set: (name, bytes) => Effect.sync(() => void stored.set(name, bytes)),
            create: (name, bytes) =>
              Effect.sync(() => {
                expect(stored.has(name)).toBe(false);
                stored.set(name, bytes);
              }),
            remove: (name) => Effect.sync(() => void stored.delete(name)),
            getOrCreateRandom: (name, size) =>
              Effect.sync(() => {
                const bytes = stored.get(name) ?? new Uint8Array(size).fill(7);
                stored.set(name, bytes);
                return bytes;
              }),
          }),
        );
        const secrets = yield* SecretRequests.SecretRequests.pipe(
          Effect.provide(
            SecretRequests.layer.pipe(
              Layer.provide(Layer.mergeAll(threads, store, ServerSettings.layerTest())),
            ),
          ),
        );
        const now = DateTime.makeUnsafe("2026-01-01T00:00:00Z");
        const sessions = Layer.mock(SessionStore.SessionStore)({
          cookieName: "test",
          legacyCookieName: undefined,
          listActive: () =>
            Effect.succeed([
              {
                sessionId,
                subject: "desktop-bootstrap",
                principalKind: "person",
                method: "bearer-access-token",
                scopes: ["orchestration:operate"],
                client: { label: "Test", deviceType: "unknown" },
                issuedAt: now,
                expiresAt: DateTime.add(now, { days: 3650 }),
                lastConnectedAt: now,
                connected: true,
                current: true,
              },
            ]),
        });
        const handoffs = yield* Handoffs.Handoffs.pipe(
          Effect.provide(
            Handoffs.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  threads,
                  store,
                  sessions,
                  Layer.succeed(SecretRequests.SecretRequests, secrets),
                ),
              ),
            ),
          ),
        );
        const requestSecret = makeRequestSecret({
          threadManagement: yield* ThreadManagement.ThreadManagementService,
          secretRequests: secrets,
          loadThreadCaller: () =>
            orchestrator.getThreadProjection(threadId).pipe(
              Effect.map((parent) => ({ scope, parent })),
              Effect.orDie,
            ),
          requestKey: (key) => Effect.succeed(key ?? "generated"),
        });
        const input = {
          kind: "card" as const,
          label: "Login",
          reason: "Sign in",
          origin: "https://card.test",
          clientRequestId: "login-ask",
          wait: false,
        };
        const pending = yield* requestSecret(scope, input);
        yield* worker.drain();
        const pendingProjection = yield* orchestrator.getThreadProjection(threadId);
        const card = pendingProjection.turnItems.find((item) => item.type === "secret_request");
        expect(card).toMatchObject({
          type: "secret_request",
          requestKind: "card",
          siteOrigin: "https://card.test",
        });
        if (!card?.runId) return yield* Effect.die("missing login card or run");
        const runId = card.runId;
        yield* handoffs.answerSecret({ threadId, turnItemId: card.id, answer }, sessionId);
        yield* worker.drain();
        const saved = yield* requestSecret(scope, input);
        expect(saved).toMatchObject({ status: "saved", secretRef: expect.any(String) });
        if (saved.status !== "saved" || !("secretRef" in saved))
          return yield* Effect.die("login ref missing");
        const connected = yield* Deferred.make<void>();
        const monitoredBroker = Layer.unwrap(
          Effect.gen(function* () {
            const broker = yield* Broker.PreviewAutomationBroker;
            return Layer.succeed(Broker.PreviewAutomationBroker, {
              ...broker,
              connect: (...args) =>
                broker
                  .connect(...args)
                  .pipe(
                    Effect.map((events) =>
                      events.pipe(
                        Stream.tap((event) =>
                          event.type === "connected"
                            ? Deferred.succeed(connected, undefined)
                            : Effect.void,
                        ),
                      ),
                    ),
                  ),
            });
          }),
        ).pipe(Layer.provide(Broker.layer));
        const browserLayer = ServerBrowser.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              database,
              ServerSettings.layerTest(),
              Manager.layer,
              monitoredBroker,
              Layer.succeed(SecretRequests.SecretRequests, secrets),
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
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), { prefix: "goat-card-sentinel-" }),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        );
        const browserEvidence = yield* Effect.gen(function* () {
          yield* ServerBrowser.ServerBrowser;
          yield* Deferred.await(connected);
          const broker = yield* Broker.PreviewAutomationBroker;
          const opened = yield* broker.invoke<PreviewAutomationStatus>({
            scope,
            operation: "open",
            input: { url: "https://card.test/", reuseExistingTab: false, show: false },
          });
          if (!opened.tabId) return yield* Effect.die("missing browser tab");
          const tabId = PreviewTabId.make(opened.tabId);
          const page = contexts.at(-1)?.pages()[0];
          if (!page) return yield* Effect.die("missing browser page");
          yield* Effect.promise(() => page.locator("#number").focus());
          const registration = McpHttpServer.toolkitRegistration(
            PreviewStandardToolkit,
            PreviewHandlers.layerStandard,
          ).pipe(
            Layer.provideMerge(McpServer.McpServer.layer),
            Layer.provide(
              Layer.mergeAll(
                layerPermissionProfilesOff,
                threads,
                Layer.succeed(Broker.PreviewAutomationBroker, broker),
                Layer.mock(SiteNotes.SiteNotes)({
                  noteFor: () => undefined,
                  list: () => [],
                  deliverOnce: () => undefined,
                  hasTouched: () => false,
                }),
              ),
            ),
            Layer.provideMerge(database),
          );
          const callFill = (secretRef = saved.secretRef) =>
            McpServer.McpServer.pipe(
              Effect.flatMap((server) =>
                server.callTool({
                  name: "goat_preview_fill_card",
                  arguments: { tabId, secretRef },
                }),
              ),
              Effect.provideService(McpSchema.McpServerClient, mcpClient),
              Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
              Effect.provide(registration),
            );
          const mcp = yield* callFill();
          expect(mcp.isError, JSON.stringify(mcp)).not.toBe(true);
          expect(mcp.structuredContent).toMatchObject({
            numberFilled: true,
            cvcFilled: true,
            verdict: "confirmed",
          });
          expect(yield* Effect.promise(() => page.locator("#number").inputValue())).toBe(number);
          expect(yield* Effect.promise(() => page.locator("#month").inputValue())).toBe("01");
          expect(yield* Effect.promise(() => page.locator("#year").inputValue())).toBe("2029");
          expect(yield* Effect.promise(() => page.locator("#cvc").inputValue())).toBe(cvc);
          expect(yield* Effect.promise(() => page.locator("#name").inputValue())).toBe(name);
          expect(Option.isNone(yield* secrets.savedRef({ threadId, turnItemId: card.id }))).toBe(
            true,
          );
          const firstLogs = yield* broker
            .invoke({ scope, tabId, operation: "logs", input: {} })
            .pipe(Effect.result);
          const firstSnapshot = yield* broker
            .invoke({ scope, tabId, operation: "snapshot", input: { captureImage: false } })
            .pipe(Effect.result);
          expect(firstLogs._tag).toBe("Success");
          expect(JSON.stringify(firstLogs)).toContain("echo");
          expect(firstSnapshot._tag).toBe("Failure");
          yield* Effect.promise(() => page.reload());
          yield* Effect.promise(() => page.locator("#number").focus());
          const input2 = { ...input, clientRequestId: "login-ask-2" };
          const pending2 = yield* requestSecret(scope, input2);
          yield* worker.drain();
          const projection2 = yield* orchestrator.getThreadProjection(threadId);
          const card2 = projection2.turnItems.find(
            (item) => item.type === "secret_request" && item.id !== card.id,
          );
          if (!card2) return yield* Effect.die("second login card missing");
          yield* handoffs.answerSecret({ threadId, turnItemId: card2.id, answer }, sessionId);
          yield* worker.drain();
          const saved2 = yield* requestSecret(scope, input2);
          if (saved2.status !== "saved" || !("secretRef" in saved2))
            return yield* Effect.die("second login ref missing");
          const tabHost = yield* makePreviewTargetHost(broker);
          const screen = yield* Effect.gen(function* () {
            const service = yield* ScreenRunService;
            return yield* service.runCell({
              runId,
              turnId: "t",
              threadId,
              environmentId: scope.environmentId,
              invocation: scope,
              source: `const tab = await screen.tab(${JSON.stringify(tabId)}); const filled = await tab.fillCard(${JSON.stringify(saved2.secretRef)}); let observed; try { observed = await tab.observe(); } catch (error) { observed = { code: error.code }; } return { filled, observed };`,
            });
          }).pipe(
            Effect.provide(
              ScreenRunService.layerWithRuntime({
                dispatcher: createScreenDispatchRouter({ tab: tabHost }),
                tabHost,
                invocation: {
                  command: process.execPath,
                  entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
                },
                assetResolver: () => resolveScreenRuntimeAsset("dev"),
              }).pipe(Layer.provide(NodeServices.layer)),
            ),
          );
          expect(screen.status, JSON.stringify(screen.error)).toBe("completed");
          expect(screen.value).toMatchObject({
            filled: { numberFilled: true, cvcFilled: true, verdict: "confirmed" },
          });
          expect(yield* Effect.promise(() => page.locator("#number").inputValue())).toBe(number);
          expect(yield* Effect.promise(() => page.locator("#cvc").inputValue())).toBe(cvc);
          expect(yield* Effect.promise(() => page.locator("#name").inputValue())).toBe(name);
          expect(yield* Effect.promise(() => page.locator("#month").inputValue())).toBe("01");
          expect(yield* Effect.promise(() => page.locator("#year").inputValue())).toBe("2029");
          expect(Option.isNone(yield* secrets.savedRef({ threadId, turnItemId: card2.id }))).toBe(
            true,
          );
          const logs = yield* broker
            .invoke({ scope, tabId, operation: "logs", input: {} })
            .pipe(Effect.result);
          const snapshot = yield* broker
            .invoke({ scope, tabId, operation: "snapshot", input: { captureImage: false } })
            .pipe(Effect.result);
          expect(logs._tag).toBe("Success");
          expect(snapshot._tag).toBe("Failure");
          expect(screen.value).toHaveProperty("observed");
          yield* Effect.promise(() => page.reload());
          yield* Effect.promise(() => page.locator("#number").focus());
          const partialInput = { ...input, clientRequestId: "card-partial" };
          const partialPending = yield* requestSecret(scope, partialInput);
          yield* worker.drain();
          const partialProjection = yield* orchestrator.getThreadProjection(threadId);
          const partialCard = partialProjection.turnItems.find(
            (item) => item.type === "secret_request" && item.id !== card.id && item.id !== card2.id,
          );
          if (!partialCard) return yield* Effect.die("partial card missing");
          yield* handoffs.answerSecret({ threadId, turnItemId: partialCard.id, answer }, sessionId);
          yield* worker.drain();
          const partialSaved = yield* requestSecret(scope, partialInput);
          if (partialSaved.status !== "saved" || !("secretRef" in partialSaved))
            return yield* Effect.die("partial card ref missing");
          const entered = yield* Deferred.make<void>();
          const resume = Promise.withResolvers<void>();
          fault.afterNumber = async () => {
            Deferred.doneUnsafe(entered, Effect.void);
            await resume.promise;
          };
          const attempt = yield* callFill(partialSaved.secretRef).pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          yield* Effect.promise(() => page.goto("https://other.test/"));
          resume.resolve();
          const partialFill = yield* Fiber.join(attempt);
          fault.afterNumber = undefined;
          expect(partialFill.isError).not.toBe(true);
          expect(partialFill.structuredContent).toMatchObject({
            numberFilled: true,
            cvcFilled: false,
            verdict: "unverifiable",
          });
          expect(
            Option.isNone(yield* secrets.savedRef({ threadId, turnItemId: partialCard.id })),
          ).toBe(true);
          const partialRetry = yield* callFill(partialSaved.secretRef);
          expect(partialRetry.isError).toBe(true);
          return {
            partialPending,
            partialSaved,
            partialFill,
            partialRetry,
            mcp,
            pending2,
            saved2,
            screen,
            firstLogs,
            firstSnapshot,
            logs,
            snapshot,
          };
        }).pipe(Effect.provide(browserLayer));
        yield* worker.drain();
        const projection = yield* orchestrator.getThreadProjection(threadId);
        const events = yield* EventStore.EventStoreV2.pipe(
          Effect.flatMap((store) => store.read({ threadId }).pipe(Stream.runCollect)),
          Effect.provide(EventStore.layer.pipe(Layer.provide(database))),
        );
        expect(events.length).toBeGreaterThan(0);
        expect(projection.turnItems.length).toBeGreaterThan(1);
        expect(capturedLogs.length).toBeGreaterThan(0);
        const visible = JSON.stringify({
          pending,
          saved,
          turnItems: projection.turnItems,
          events,
          browserEvidence,
          capturedLogs,
        });
        for (const secret of [number, name]) expect(visible).not.toContain(secret);
        expect(visible).not.toMatch(cvcLeak);
      }).pipe(
        Effect.provide(
          Harness.layerWithRegistry(
            { name: "card-sentinel" },
            Registry.layerFromAdapters([adapter]),
            { runEffectWorker: false, databaseLayer: database },
          ).pipe(Layer.provideMerge(database)),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  ).pipe(Effect.provide(logger));
});
