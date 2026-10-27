import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { CodexSettings, ProviderSessionId, RunAttemptId, ThreadId } from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as MemoryDerivedCache from "../../memory/MemoryDerivedCache.ts";
import { codexHomeRouteArgv } from "../../provider/CodexHomeRouteConfig.ts";
import * as HomeRoute from "../../provider/OpenCodexRoute.ts";
import nativeConfigRead from "../../provider/testFixtures/codexHomeConfigRead.0.156.1.json" with { type: "json" };
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import {
  CODEX_TEST_MODEL_SELECTION,
  CODEX_TEST_RUNTIME_POLICY,
  makeCodexTestTurnInput,
  makeReplayServerConfig,
  withReplayRequestId,
} from "./CodexAdapterV2.testkit.ts";
import { codexReplayPreamble, makeCodexReplayTranscript } from "./CodexReplay.testkit.ts";

const decodeSettings = Schema.decodeSync(CodexSettings);
const BASE_URL = "http://127.0.0.1:10100/v1";
const layer = Layer.mergeAll(
  MemoryDerivedCache.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  NodeServices.layer,
);
/** A Home route with OpenAI authentication names the built-in provider on every new thread. */
const withHomeOpenAiProvider = (
  entry: CodexReplay.CodexAppServerReplayEntry,
): CodexReplay.CodexAppServerReplayEntry => {
  if (entry.type !== "expect_outbound") return entry;
  const frame = entry.frame as {
    readonly method?: string;
    readonly params?: { readonly config: object };
  };
  return frame.method === "thread/start" && frame.params
    ? {
        ...entry,
        frame: {
          ...frame,
          params: {
            ...frame.params,
            modelProvider: "openai",
            config: { ...frame.params.config, model_provider: "openai" },
          },
        },
      }
    : entry;
};

describe("OpenCodex Home provider on native threads", () => {
  it.effect.each(["openai", "none"] as const)(
    "starts, resumes and forks Home threads with the instance's current %s provider",
    (opencodexAuth) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const workspace = path.resolve("/workspace");
        const catalog = path.resolve("/route-catalog.json");
        const settings = decodeSettings({
          modelRoute: "opencodex",
          opencodexAuth,
          homePath: "/execution-home",
        });
        const provider = opencodexAuth === "none" ? "opencodex" : "openai";
        const effective =
          opencodexAuth === "none"
            ? {
                model_provider: "opencodex",
                model_catalog_json: catalog,
                model_providers: { opencodex: nativeConfigRead.captures.clean.opencodex },
              }
            : { model_provider: "openai", openai_base_url: BASE_URL, model_catalog_json: catalog };
        const routed = {
          modelProvider: provider,
          config: {
            ...CodexAdapterV2.CODEX_THREAD_CONFIG,
            model_provider: provider,
            ...(opencodexAuth === "none"
              ? {
                  "model_providers.opencodex": {
                    name: "OpenCodex",
                    base_url: BASE_URL,
                    wire_api: "responses",
                    requires_openai_auth: false,
                  },
                }
              : {}),
          },
        };
        const configRead = (id: number): ReadonlyArray<CodexReplay.CodexAppServerReplayEntry> => [
          {
            type: "expect_outbound",
            label: `config/read ${id}`,
            frame: { id, method: "config/read", params: { cwd: workspace, includeLayers: false } },
          },
          {
            type: "emit_inbound",
            label: `config/read ${id}`,
            frame: { id, result: { config: effective, origins: {} } },
          },
        ];
        const nativeThreadId = "home-history";
        const forkThreadId = "home-fork";
        const preamble = codexReplayPreamble({
          nativeThreadId,
          nativeTurnId: "unused",
          prompt: "",
        });
        const started = preamble[4];
        if (started?.type !== "emit_inbound") throw new Error("Expected a thread/start result");
        const startedResult = (started.frame as { readonly result: { readonly thread: object } })
          .result;
        const transcript = makeCodexReplayTranscript({
          scenario: `home-provider-${opencodexAuth}`,
          entries: [
            ...preamble.slice(0, 3),
            ...configRead(2),
            ...configRead(3),
            {
              type: "expect_outbound",
              label: "thread/start",
              frame: { id: 4, method: "thread/start", params: routed },
            },
            withReplayRequestId(started, 4),
            ...configRead(5),
            {
              type: "expect_outbound",
              label: "thread/resume",
              frame: {
                id: 6,
                method: "thread/resume",
                params: { threadId: nativeThreadId, excludeTurns: true, ...routed },
              },
            },
            {
              type: "emit_inbound",
              label: "thread/resume",
              frame: { id: 6, result: { thread: { id: nativeThreadId, updatedAt: 1782622450 } } },
            },
            ...configRead(7),
            {
              type: "expect_outbound",
              label: "thread/fork",
              frame: {
                id: 8,
                method: "thread/fork",
                params: { threadId: nativeThreadId, ...routed },
              },
            },
            {
              type: "emit_inbound",
              label: "thread/fork",
              frame: {
                id: 8,
                result: {
                  ...startedResult,
                  thread: {
                    ...startedResult.thread,
                    id: forkThreadId,
                    sessionId: forkThreadId,
                    forkedFromId: nativeThreadId,
                  },
                },
              },
            },
          ],
        });
        const driver = yield* CodexReplay.makeReplayDriver(transcript);
        const adapter = yield* CodexAdapterV2.makeCodexAdapterV2({
          instanceId: CODEX_TEST_MODEL_SELECTION.instanceId,
          settings,
          environment: {},
          clientFactory: {
            open: () =>
              Layer.build(CodexReplay.layerReplayWithDriver(driver)).pipe(
                Effect.map((context) => Context.get(context, CodexClient.CodexAppServerClient)),
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapter.ProviderAdapterOpenSessionError({
                      driver: CodexAdapterV2.CODEX_DRIVER_KIND,
                      providerSessionId: ProviderSessionId.make("home-provider-session"),
                      cause,
                    }),
                ),
              ),
          },
          crypto: yield* Crypto.Crypto,
          fileSystem: yield* FileSystem.FileSystem,
          idAllocator: yield* IdAllocator.IdAllocatorV2,
          serverConfig: yield* makeReplayServerConfig("home-provider").pipe(Effect.orDie),
        }).pipe(
          Effect.provideService(HomeRoute.OpenCodexRoute, {
            inspect: () => Effect.die("unused"),
            launchArgs: (input) =>
              Effect.succeed(codexHomeRouteArgv(input.settings, BASE_URL, catalog)),
            requireAvailable: () => Effect.void,
          }),
        );
        const runtimePolicy = { ...CODEX_TEST_RUNTIME_POLICY, cwd: workspace };
        const threadId = ThreadId.make("home-provider-owner");
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("home-provider-session"),
          modelSelection: CODEX_TEST_MODEL_SELECTION,
          runtimePolicy,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: CODEX_TEST_MODEL_SELECTION,
          runtimePolicy,
        });
        const resumed = yield* runtime.resumeThread({
          providerThread,
          modelSelection: CODEX_TEST_MODEL_SELECTION,
          runtimePolicy,
        });
        const forked = yield* runtime.forkThread({
          sourceProviderThread: providerThread,
          sourceProviderTurns: [],
          targetThreadId: ThreadId.make("home-provider-fork"),
        });
        assert.equal(resumed.nativeThreadRef?.nativeId, nativeThreadId);
        assert.equal(forked.nativeThreadRef?.nativeId, forkThreadId);
        assert.equal(forked.forkedFrom?.providerThreadId, providerThread.id);
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});

describe("OpenCodex Home routing", () => {
  it.effect(
    "reads the actual session config after initialize and checks Home before a goal command",
    () =>
      Effect.gen(function* () {
        // A real project cwd is native, which is drive-qualified on Windows.
        const path = yield* Path.Path;
        const workspace = path.resolve("/workspace");
        const runtimePolicy = { ...CODEX_TEST_RUNTIME_POLICY, cwd: workspace };
        const catalog = path.resolve("/route-catalog.json");
        const preamble = codexReplayPreamble({
          nativeThreadId: "home-thread",
          nativeTurnId: "unused",
          prompt: "unused",
        });
        const transcript = makeCodexReplayTranscript({
          scenario: "actual-home-config",
          entries: [
            ...preamble.slice(0, 3),
            {
              type: "expect_outbound",
              label: "actual-config",
              frame: {
                id: 2,
                method: "config/read",
                params: { cwd: workspace, includeLayers: false },
              },
            },
            {
              type: "emit_inbound",
              label: "actual-config",
              frame: {
                id: 2,
                result: {
                  config: {
                    model_provider: "openai",
                    openai_base_url: "http://127.0.0.1:10100/v1",
                    model_catalog_json: catalog,
                  },
                  origins: {},
                },
              },
            },
            {
              type: "expect_outbound",
              label: "thread-config",
              frame: {
                id: 3,
                method: "config/read",
                params: { cwd: workspace, includeLayers: false },
              },
            },
            {
              type: "emit_inbound",
              label: "thread-config",
              frame: {
                id: 3,
                result: {
                  config: {
                    model_provider: "openai",
                    openai_base_url: "http://127.0.0.1:10100/v1",
                    model_catalog_json: catalog,
                  },
                  origins: {},
                },
              },
            },
            ...preamble
              .slice(3, 5)
              .map((entry) => withReplayRequestId(withHomeOpenAiProvider(entry), 4)),
            {
              type: "expect_outbound",
              label: "existing-context-config",
              frame: {
                id: 5,
                method: "config/read",
                params: { cwd: workspace, includeLayers: false },
              },
            },
            {
              type: "emit_inbound",
              label: "existing-context-config",
              frame: {
                id: 5,
                result: {
                  config: {
                    model_provider: "openai",
                    openai_base_url: "http://127.0.0.1:10100/v1",
                    model_catalog_json: catalog,
                  },
                  origins: {},
                },
              },
            },
            {
              type: "expect_outbound",
              label: "second-cwd-config",
              frame: {
                id: 6,
                method: "config/read",
                params: { cwd: "/second-project", includeLayers: false },
              },
            },
            {
              type: "emit_inbound",
              label: "second-cwd-config",
              frame: {
                id: 6,
                result: {
                  config: {
                    model_provider: "openai",
                    openai_base_url: "http://127.0.0.1:10101/v1",
                    model_catalog_json: catalog,
                  },
                  origins: {},
                },
              },
            },
          ],
        });
        const driver = yield* CodexReplay.makeReplayDriver(transcript);
        let disconnected = false;
        let opens = 0;
        const adapter = yield* CodexAdapterV2.makeCodexAdapterV2({
          instanceId: CODEX_TEST_MODEL_SELECTION.instanceId,
          settings: {
            ...decodeSettings({}),
            modelRoute: "opencodex",
            homePath: "/execution-home",
          },
          environment: {},
          clientFactory: {
            open: () =>
              Effect.gen(function* () {
                opens++;
                const context = yield* Layer.build(CodexReplay.layerReplayWithDriver(driver));
                return Context.get(context, CodexClient.CodexAppServerClient);
              }).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapter.ProviderAdapterOpenSessionError({
                      driver: CodexAdapterV2.CODEX_DRIVER_KIND,
                      providerSessionId: ProviderSessionId.make("home-session"),
                      cause,
                    }),
                ),
              ),
          },
          crypto: yield* Crypto.Crypto,
          fileSystem: yield* FileSystem.FileSystem,
          idAllocator: yield* IdAllocator.IdAllocatorV2,
          serverConfig: yield* makeReplayServerConfig("actual-home-config").pipe(Effect.orDie),
        }).pipe(
          Effect.provideService(HomeRoute.OpenCodexRoute, {
            inspect: () => Effect.die("unused"),
            launchArgs: () =>
              Effect.succeed([
                "-c",
                'model_provider="openai"',
                "-c",
                'openai_base_url="http://127.0.0.1:10100/v1"',
                "-c",
                `model_catalog_json=${JSON.stringify(catalog)}`,
              ]),
            requireAvailable: () =>
              disconnected
                ? Effect.fail(
                    new HomeRoute.OpenCodexRouteUnavailable({ detail: "Home disconnected" }),
                  )
                : Effect.void,
          }),
        );
        const threadId = ThreadId.make("actual-home-owner");
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("home-session"),
          modelSelection: CODEX_TEST_MODEL_SELECTION,
          runtimePolicy,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: CODEX_TEST_MODEL_SELECTION,
          runtimePolicy,
        });
        const mismatch = yield* runtime
          .ensureThread({
            threadId: ThreadId.make("second-project-owner"),
            modelSelection: CODEX_TEST_MODEL_SELECTION,
            runtimePolicy: { ...CODEX_TEST_RUNTIME_POLICY, cwd: "/second-project" },
          })
          .pipe(Effect.result);
        assert.equal(mismatch._tag, "Failure");
        disconnected = true;
        const result = yield* runtime
          .startTurn(
            makeCodexTestTurnInput({
              threadId,
              providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make("home-goal-attempt"),
              text: "/goal keep working",
            }),
          )
          .pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        assert.equal(opens, 1);
        assert.equal(runtime.instanceId, CODEX_TEST_MODEL_SELECTION.instanceId);
      }).pipe(Effect.provide(layer)),
  );
});
