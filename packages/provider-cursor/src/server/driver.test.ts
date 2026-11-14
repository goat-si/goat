// @effect-diagnostics nodeBuiltinImport:off
import type { AgentOptions, SDKModel } from "@cursor/sdk";
import * as HostProcess from "@goat/shared/HostProcess";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { vi } from "vite-plus/test";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Deferred from "effect/Deferred";

import { DEFAULT_HANDOFF_TOKEN_CAP, handoffBudget } from "@goat/provider-core/server/handoffBudget";
import * as ProviderEventLoggers from "@goat/provider-core/server/ProviderEventLoggers";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import { CursorDriver } from "./driver.ts";
import * as CursorAgentSdk from "./CursorAgentSdk.ts";
import * as CursorSdk from "./CursorSdk.ts";
import * as CursorKeychain from "./CursorKeychain.ts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import { loadCursorSdk } from "./sdk.ts";

const { Cursor } = loadCursorSdk();

const layerTest = TestProviderHost.layer({ runBackgroundWork: false }).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
  Layer.provideMerge(CursorSdk.layer),
  Layer.provideMerge(
    Layer.mock(CursorAgentSdk.CursorAgentSdkRunner)({
      open: () => Effect.die("Maintenance resolution must not open a Cursor session"),
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(CursorKeychain.CursorKeychain, {
      accessToken: Effect.die("The driver test must not read the Keychain"),
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Disabled Cursor must not make an HTTP request")),
    ),
  ),
);

it.layer(layerTest)("CursorDriver", (it) => {
  it.effect("keeps the session key when MCP configuration reopens an agent", () =>
    Effect.gen(function* () {
      const host: NodeJS.ProcessEnv = { PATH: "/usr/bin", CURSOR_API_KEY: "old-key" };
      const openedKeys: Array<string | undefined> = [];
      const instanceId = ProviderInstanceId.make("cursor-session-key");
      const threadId = ThreadId.make("cursor-session-key-thread");
      const instance = yield* CursorDriver.create({
        instanceId,
        displayName: undefined,
        enabled: true,
        environment: [],
        config: CursorDriver.defaultConfig(),
      }).pipe(
        Effect.provideService(HostProcess.Environment, host),
        Effect.provideService(CursorAgentSdk.CursorAgentSdkRunner, {
          assertComplete: Effect.void,
          open: (request) =>
            Effect.sync(() => {
              openedKeys.push(request.options.apiKey);
              return {
                agentId: "agent",
                listMessages: Effect.succeed([]),
                send: () => Effect.die("unused"),
                close: Effect.void,
              };
            }),
        }),
      );
      const modelSelection = { instanceId, model: "auto" };
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const open = (id: string) =>
        instance.orchestrationAdapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make(id),
          modelSelection,
          runtimePolicy,
        });
      const first = yield* open("first");
      const thread = yield* first.ensureThread({ threadId, modelSelection, runtimePolicy });
      host.CURSOR_API_KEY = "new-key";
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      yield* sessions.set({
        environmentId: EnvironmentId.make("environment"),
        threadId,
        providerSessionId: "mcp",
        providerInstanceId: instanceId,
        endpoint: "http://127.0.0.1:43123/mcp",
        authorizationHeader: "Bearer rotated",
        browserToolsAvailable: false,
      });
      yield* first.resumeThread({ providerThread: thread });
      const second = yield* open("second");
      yield* second.ensureThread({ threadId, modelSelection, runtimePolicy });
      expect(openedKeys).toEqual(["old-key", "old-key", "new-key"]);
    }).pipe(Effect.scoped),
  );
  it.effect(
    "regression #3079: Cursor workspace probes use the current host environment and respect instance overrides",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const oldHome = yield* fs.makeTempDirectoryScoped({ prefix: "cursor-old-" });
        const newHome = yield* fs.makeTempDirectoryScoped({ prefix: "cursor-new-" });
        yield* fs.makeDirectory(`${newHome}/.cursor/skills/fresh`, { recursive: true });
        yield* fs.writeFileString(
          `${newHome}/.cursor/skills/fresh/SKILL.md`,
          "---\nname: fresh\ndescription: fresh skill\n---\nhello\n",
        );
        const host = { HOME: oldHome, PATH: "/old/bin" };
        const make = (override: boolean) =>
          CursorDriver.create({
            instanceId: ProviderInstanceId.make(`cursor-path-${override}`),
            displayName: undefined,
            enabled: true,
            environment: [
              { name: "FIXTURE", value: "1", sensitive: false },
              ...(override ? [{ name: "HOME", value: oldHome, sensitive: false }] : []),
            ],
            config: CursorDriver.defaultConfig(),
          }).pipe(Effect.provideService(HostProcess.Environment, host));
        const inherited = yield* make(false);
        const overridden = yield* make(true);
        host.HOME = newHome;
        host.PATH = "/new/bin";
        yield* inherited.snapshot.refresh;
        expect(
          (yield* inherited.snapshotForCwd!(oldHome)).skills.map((skill) => skill.name),
        ).toContain("fresh");
        expect(
          (yield* overridden.snapshotForCwd!(oldHome)).skills.map((skill) => skill.name),
        ).not.toContain("fresh");
      }).pipe(Effect.scoped),
  );

  it.effect(
    "regression #3079: status and a new session use a CURSOR_API_KEY the host gains after the instance started",
    () =>
      Effect.gen(function* () {
        const authorizations: Array<string | undefined> = [];
        const client = HttpClient.make((request) => {
          authorizations.push(request.headers.authorization);
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json(
                request.url.endsWith("/v1/me")
                  ? { apiKeyName: "GOAT", createdAt: "2026-01-01T00:00:00.000Z" }
                  : { items: [{ id: "auto", displayName: "Auto" }] },
              ),
            ),
          );
        });
        const openedKeys: Array<string | undefined> = [];
        const host: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
        const instanceId = ProviderInstanceId.make("cursor-host-key");
        const instance = yield* CursorDriver.create({
          instanceId,
          displayName: undefined,
          enabled: true,
          environment: [],
          config: CursorDriver.defaultConfig(),
        }).pipe(
          Effect.provideService(HostProcess.Environment, host),
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.provideService(CursorAgentSdk.CursorAgentSdkRunner, {
            assertComplete: Effect.void,
            open: (request) =>
              Effect.sync(() => {
                openedKeys.push(request.options.apiKey);
                return {
                  agentId: "host-key-agent",
                  listMessages: Effect.succeed([]),
                  send: () => Effect.die("This test only opens a session"),
                  close: Effect.void,
                };
              }),
          }),
        );
        host.CURSOR_API_KEY = "host-key-new";
        // Labelled by the key the check used, not by what the instance saw when it started.
        const withKey = yield* instance.snapshot.refresh;
        expect(withKey.auth).toMatchObject({ type: "api-key", canLogout: false });
        expect(withKey.setup?.canAuthenticate).toBe(false);
        expect((yield* Effect.result(instance.auth!.start("owner")))._tag).toBe("Failure");
        expect((yield* Effect.result(instance.auth!.logout(Effect.void)))._tag).toBe("Failure");
        expect(authorizations).toContain("Bearer host-key-new");
        const threadId = ThreadId.make("cursor-host-key-thread");
        const modelSelection = { instanceId, model: "auto" };
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const runtime = yield* instance.orchestrationAdapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("cursor-host-key-session"),
          modelSelection,
          runtimePolicy,
        });
        yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
        expect(openedKeys).toEqual(["host-key-new"]);
        delete host.CURSOR_API_KEY;
        const withoutKey = yield* instance.snapshot.refresh;
        expect(withoutKey.setup?.canAuthenticate).toBe(true);
        expect(withoutKey.auth.canLogout).toBe(true);
        expect((yield* Effect.result(instance.auth!.logout(Effect.void)))._tag).toBe("Success");
      }).pipe(Effect.scoped),
  );

  it.effect(
    "persists browser credentials, uses them for chat, and closes the SDK session on logout",
    () =>
      Effect.gen(function* () {
        const login = vi.spyOn(Cursor.auth, "login").mockImplementation(async (options) => {
          options?.onLoginUrl?.("https://cursor.com/loginDeepControl?challenge=test-only");
          await options?.store?.save({
            version: 1,
            backendUrl: "https://api2.cursor.sh",
            apiKey: "instance-browser-key",
            createdAtMs: 0,
            apiKeyExpiresAtMs: 4_000_000_000_000,
            email: "cursor@example.com",
          });
          return { apiKey: "instance-browser-key", apiKeyExpiresAtMs: 4_000_000_000_000 };
        });
        const requests: Array<{ url: string; authorization: string | undefined }> = [];
        const client = HttpClient.make((request) => {
          requests.push({ url: request.url, authorization: request.headers.authorization });
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json(
                request.url.endsWith("/v1/me")
                  ? {
                      apiKeyName: "T3 Code",
                      createdAt: "2026-01-01T00:00:00.000Z",
                      userEmail: "cursor@example.com",
                    }
                  : { items: [{ id: "auto", displayName: "Auto" }] },
              ),
            ),
          );
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            login.mockRestore();
          }),
        );
        const input = {
          instanceId: ProviderInstanceId.make("cursor-browser-persisted"),
          displayName: "Personal Cursor",
          enabled: true,
          environment: [{ name: "CURSOR_API_KEY", value: "", sensitive: true }],
          config: CursorDriver.defaultConfig(),
        };
        const openedKeys: Array<string | undefined> = [];
        let closed = 0;
        const instance = yield* CursorDriver.create(input).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.provideService(CursorAgentSdk.CursorAgentSdkRunner, {
            assertComplete: Effect.void,
            open: (request) =>
              Effect.sync(() => {
                openedKeys.push(request.options.apiKey);
                return {
                  agentId: "browser-auth-agent",
                  listMessages: Effect.succeed([]),
                  send: () => Effect.die("This test only opens a session"),
                  close: Effect.sync(() => {
                    closed += 1;
                  }),
                };
              }),
          }),
        );
        expect((yield* instance.snapshot.refresh).auth.status).toBe("unauthenticated");
        yield* instance.auth!.start("client");
        yield* instance.auth!.subscribe("client").pipe(
          Stream.filter((state) => state.phase === "succeeded"),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        expect(requests).toContainEqual({
          url: "https://api.cursor.com/v1/me",
          authorization: "Bearer instance-browser-key",
        });
        expect(yield* instance.snapshot.getSnapshot).toMatchObject({
          status: "ready",
          auth: {
            status: "authenticated",
            type: "browser",
            canLogout: true,
            email: "cursor@example.com",
          },
          setup: { canAuthenticate: true, canInstall: false },
        });
        const threadId = ThreadId.make("cursor-browser-thread");
        const modelSelection = { instanceId: input.instanceId, model: "auto" };
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const runtime = yield* instance.orchestrationAdapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("cursor-browser-session"),
          modelSelection,
          runtimePolicy,
        });
        yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
        expect(openedKeys).toEqual(["instance-browser-key"]);
        expect(closed).toBe(0);
        const recreated = yield* CursorDriver.create(input).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
        );
        expect((yield* recreated.snapshot.refresh).auth.status).toBe("authenticated");
        yield* instance.auth!.logout(Effect.void);
        expect(closed).toBe(1);
        expect((yield* instance.snapshot.getSnapshot).auth.status).toBe("unauthenticated");
        expect((yield* recreated.snapshot.refresh).auth.status).toBe("unauthenticated");
        expect(
          (yield* Effect.exit(runtime.ensureThread({ threadId, modelSelection, runtimePolicy })))
            ._tag,
        ).toBe("Failure");
        expect(openedKeys).toEqual(["instance-browser-key"]);
        expect(closed).toBe(1);
      }).pipe(Effect.scoped),
  );

  it.effect("budgets handoffs for the SDK model across catalog refreshes and option changes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cursor-window-" });
      const catalog = yield* Deferred.make<Array<SDKModel>>();
      const catalogRequested = yield* Deferred.make<void>();
      let failUser = false;
      const client = HttpClient.make((request) =>
        Effect.gen(function* () {
          if (request.url.endsWith("/v1/me"))
            return HttpClientResponse.fromWeb(
              request,
              Response.json(
                failUser
                  ? { error: { message: "Cursor is unreachable" } }
                  : { apiKeyName: "T3 Code", createdAt: "2026-01-01T00:00:00.000Z" },
                { status: failUser ? 503 : 200 },
              ),
            );
          yield* Deferred.succeed(catalogRequested, undefined);
          const models = yield* Deferred.await(catalog);
          return HttpClientResponse.fromWeb(request, Response.json({ items: models }));
        }),
      );
      const instanceId = ProviderInstanceId.make("cursor-catalog-window");
      const openedModels: Array<AgentOptions["model"]> = [];
      const sentModels: Array<AgentOptions["model"]> = [];
      const instance = yield* CursorDriver.create({
        instanceId,
        displayName: "Cursor",
        enabled: true,
        environment: [{ name: "CURSOR_API_KEY", value: "catalog-window-key", sensitive: true }],
        config: CursorDriver.defaultConfig(),
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provideService(CursorAgentSdk.CursorAgentSdkRunner, {
          assertComplete: Effect.void,
          open: (request) =>
            Effect.sync(() => {
              openedModels.push(request.options.model);
              return {
                agentId: "native-cursor-window",
                listMessages: Effect.succeed([]),
                close: Effect.void,
                send: (input) =>
                  Effect.sync(() => {
                    sentModels.push(input.options?.model);
                    const runId = `native-cursor-window-run-${sentModels.length}`;
                    return {
                      agentId: "native-cursor-window",
                      runId,
                      cancel: Effect.void,
                      wait: Effect.succeed({
                        id: runId,
                        requestId: runId,
                        status: "finished" as const,
                        model: { id: "claude-opus-5-5" },
                        durationMs: 1,
                      }),
                    };
                  }),
              };
            }),
        }),
      );
      const selection = (contextWindow?: string) => ({
        instanceId,
        model: "claude-opus-5-5",
        ...(contextWindow === undefined
          ? {}
          : { options: [{ id: "contextWindow", value: contextWindow }] }),
      });
      const threadId = ThreadId.make("cursor-catalog-window-thread");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: workspace,
      });
      const runtime = yield* instance.orchestrationAdapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("cursor-catalog-window-session"),
        modelSelection: selection("1m"),
        runtimePolicy,
      });
      const refresh = yield* instance.snapshot.refresh.pipe(Effect.forkScoped);
      yield* Deferred.await(catalogRequested);
      expect(runtime.getModelContextWindow?.(selection())).toBeUndefined();
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection: selection("1m"),
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      const startTurn = Effect.fnUntraced(function* (contextWindow?: string) {
        const modelSelection = selection(contextWindow);
        const ordinal = sentModels.length + 1;
        yield* runtime.startTurn({
          threadId,
          providerThread,
          modelSelection,
          runtimePolicy,
          runId: RunId.make(`cursor-window-run-${ordinal}`),
          runOrdinal: ordinal,
          providerTurnOrdinal: ordinal,
          attemptId: RunAttemptId.make(`cursor-window-attempt-${ordinal}`),
          rootNodeId: NodeId.make(`cursor-window-root-${ordinal}`),
          appThread: {
            id: threadId,
            projectId: ProjectId.make("cursor-window-project"),
            createdBy: "user",
            creationSource: "web",
            title: "Cursor context window",
            providerInstanceId: instanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: providerThread.id,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
          message: {
            messageId: MessageId.make(`cursor-window-message-${ordinal}`),
            createdBy: "user",
            creationSource: "web",
            text: "Continue.",
            attachments: [],
          },
        });
        yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runDrain,
        );
        const window = runtime.getModelContextWindow?.(modelSelection);
        return {
          model: sentModels.at(-1),
          window,
          allowance: handoffBudget({
            tokenCap: DEFAULT_HANDOFF_TOKEN_CAP,
            userText: "Continue.",
            attachments: [],
            providerThread,
            nativeContextEstimate: 400_000,
            modelContextWindow: window,
          }),
        };
      });
      const beforeCatalog = yield* startTurn("1m");
      yield* Deferred.succeed(catalog, [
        {
          id: "claude-opus-5-5",
          displayName: "Claude Opus 5.5",
          parameters: [
            {
              id: "context",
              displayName: "Context",
              values: [{ value: "300k" }, { value: "1m" }],
            },
          ],
          variants: [
            {
              displayName: "Claude Opus 5.5",
              isDefault: true,
              params: [{ id: "context", value: "1m" }],
            },
          ],
        },
      ]);
      expect((yield* Fiber.join(refresh)).status).toBe("ready");
      const catalogDefault = yield* startTurn();
      const explicitWindow = yield* startTurn("500k");
      const unknownWindow = yield* startTurn("max");
      failUser = true;
      expect((yield* instance.snapshot.refresh).status).toBe("error");
      const retainedDefault = yield* startTurn();

      expect(openedModels).toEqual([
        {
          id: "claude-opus-5-5",
          params: [{ id: "context", value: "1m" }],
        },
      ]);
      expect({
        beforeCatalog,
        catalogDefault,
        explicitWindow,
        unknownWindow,
        retainedDefault,
      }).toEqual({
        beforeCatalog: {
          model: { id: "claude-opus-5-5", params: [{ id: "context", value: "1m" }] },
          window: 1_000_000,
          allowance: DEFAULT_HANDOFF_TOKEN_CAP,
        },
        catalogDefault: {
          model: { id: "claude-opus-5-5" },
          window: 1_000_000,
          allowance: DEFAULT_HANDOFF_TOKEN_CAP,
        },
        explicitWindow: {
          model: { id: "claude-opus-5-5", params: [{ id: "context", value: "500k" }] },
          window: 500_000,
          allowance: 0,
        },
        unknownWindow: {
          model: { id: "claude-opus-5-5", params: [{ id: "context", value: "max" }] },
          window: undefined,
          allowance: 0,
        },
        retainedDefault: catalogDefault,
      });
    }).pipe(Effect.scoped),
  );
});
