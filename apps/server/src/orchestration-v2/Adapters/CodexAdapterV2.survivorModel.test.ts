import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CodexSettings,
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  type ServerProviderModel,
  ThreadId,
} from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as ProviderHost from "@goat/provider-core/server/ProviderHost";
import { makeManagedServerProvider } from "@goat/provider-core/server/managedProvider";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Test fixture paths.
import * as NodePath from "node:path";

import * as MemoryDerivedCache from "../../memory/MemoryDerivedCache.ts";
import * as CodexSurvivors from "../../provider/CodexSurvivors.ts";
import { restartRequiredIn } from "../ProviderSessionRetirement.ts";
import * as CodexAdapter from "./CodexAdapterV2.ts";
import {
  CODEX_TEST_MODEL_SELECTION,
  CODEX_TEST_RUNTIME_POLICY,
  makeCodexTestTurnInput,
  makeReplayServerConfig,
} from "./CodexAdapterV2.testkit.ts";
import {
  codexReplayPreamble,
  makeCodexReplayTranscript,
  makeCodexReplayTurn,
} from "./CodexReplay.testkit.ts";

const layerTest = Layer.mergeAll(
  MemoryDerivedCache.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  NodeServices.layer,
);
const decodeCodexSettings = Schema.decodeEffect(CodexSettings);

/** Survivor records with no binding left, as when one is released after the turn's open. */
const noSurvivors = CodexSurvivors.CodexSurvivors.of({
  list: Effect.succeed([]),
  startBlockedThreads: Effect.succeed([]),
  setStartWake: () => Effect.void,
  onFenceChange: () => Effect.void,
  release: () => Effect.void,
  classifyRecord: () => Effect.succeed({ type: "unverifiable" }),
  classifyExisting: () => Effect.succeed("survivor" as const),
  replace: () => Effect.void,
  // @effect-diagnostics-next-line effectSucceedWithVoid:off - An absent binding is undefined, not void.
  get: () => Effect.succeed(undefined),
  getGoalBlocks: () => Effect.succeed([]),
  listGoalBlocksByInstance: () => Effect.succeed([]),
  getStopObligations: () => Effect.succeed([]),
  recordStopObligation: () => Effect.void,
  clearStopObligation: () => Effect.void,
  recordGoalBlock: () => Effect.void,
  clearGoalBlock: () => Effect.void,
  hasGoalBlock: () => Effect.succeed(false),
  ensureAdmission: () => Effect.void,
});

it.effect("a restart continuation with no survivor to adopt is model-checked before Codex", () =>
  Effect.gen(function* () {
    const scenario = "survivor-model-check";
    const threadId = ThreadId.make("thread-survivor-model-check");
    const nativeThreadId = "native-thread";
    const transcript = makeCodexReplayTranscript({
      scenario,
      entries: codexReplayPreamble({ nativeThreadId, nativeTurnId: "old-turn", prompt: "x" }).slice(
        0,
        3,
      ),
    });
    const driver = yield* CodexReplay.makeReplayDriver(transcript);
    const requests: Array<string> = [];
    // The turn's model reached GOAT's list after this process read its catalog.
    const offered: Array<ServerProviderModel> = [];
    const adapter = yield* CodexAdapter.makeCodexAdapterV2({
      instanceId: CodexAdapter.CODEX_DEFAULT_INSTANCE_ID,
      settings: yield* decodeCodexSettings({}),
      environment: {},
      offeredModels: Effect.sync(() => [...offered]),
      clientFactory: {
        open: (input) =>
          Layer.build(CodexReplay.layerReplayWithDriver(driver)).pipe(
            Effect.map((context) => Context.get(context, CodexClient.CodexAppServerClient)),
            Effect.map((client): CodexClient.CodexAppServerClient["Service"] => ({
              ...client,
              raw: {
                ...client.raw,
                request: (method, params) =>
                  method === "thread/resume"
                    ? Effect.succeed({
                        thread: { id: nativeThreadId, updatedAt: 1, status: { type: "idle" } },
                      })
                    : client.raw.request(method, params),
              },
              request: ((method: string, params: unknown) =>
                Effect.gen(function* () {
                  requests.push(method);
                  if (method === "model/list")
                    return { data: [{ model: "gpt-5.4-mini" }], nextCursor: null };
                  if (method === "turn/start")
                    return { turn: makeCodexReplayTurn({ id: "new-turn", status: "inProgress" }) };
                  return yield* client.request(method as never, params as never);
                })) as typeof client.request,
            })),
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterOpenSessionError({
                  driver: CodexAdapter.CODEX_DRIVER_KIND,
                  providerSessionId: input.providerSessionId,
                  cause,
                }),
            ),
          ),
      },
      crypto: yield* Crypto.Crypto,
      fileSystem: yield* FileSystem.FileSystem,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      serverConfig: yield* makeReplayServerConfig(scenario).pipe(Effect.orDie),
    }).pipe(Effect.provideService(CodexSurvivors.CodexSurvivors, noSurvivors));
    const providerSessionId = ProviderSessionId.make("session");
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId,
      modelSelection: CODEX_TEST_MODEL_SELECTION,
      runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
    });
    offered.push({
      slug: CODEX_TEST_MODEL_SELECTION.model,
      name: CODEX_TEST_MODEL_SELECTION.model,
      isCustom: false,
      capabilities: null,
    });
    const now = yield* DateTime.now;
    const providerThread = yield* runtime.resumeThread({
      threadId,
      modelSelection: CODEX_TEST_MODEL_SELECTION,
      runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
      providerThread: {
        id: ProviderThreadId.make("provider-thread"),
        driver: CodexAdapter.CODEX_DRIVER_KIND,
        providerInstanceId: CodexAdapter.CODEX_DEFAULT_INSTANCE_ID,
        providerSessionId,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: {
          driver: CodexAdapter.CODEX_DRIVER_KIND,
          nativeId: nativeThreadId,
          strength: "strong",
        },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      },
    });

    const started = yield* runtime
      .startTurn({
        ...makeCodexTestTurnInput({
          threadId,
          providerThread,
          now,
          attemptId: RunAttemptId.make("attempt"),
          text: "continue",
        }),
        restartContinuationOfRunId: RunId.make("source-run"),
      })
      .pipe(Effect.exit);

    assert.notInclude(requests, "turn/start");
    const refused = Exit.isFailure(started) ? Cause.squash(started.cause) : undefined;
    assert.strictEqual(restartRequiredIn(refused)?.modelStatus, "predated");
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect(
  "a Codex session reads the catalog its config points at and reports a changed model",
  () =>
    Effect.gen(function* () {
      const scenario = "catalog-freshness";
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      const model = CODEX_TEST_MODEL_SELECTION.model;
      const writeCatalog = (contextWindow: number, writtenAtMs: number) =>
        fs
          .writeFileString(
            NodePath.join(home, "catalog.json"),
            JSON.stringify({ models: [{ slug: model, context_window: contextWindow }] }),
          )
          .pipe(
            Effect.andThen(
              fs.utimes(
                NodePath.join(home, "catalog.json"),
                writtenAtMs / 1000,
                writtenAtMs / 1000,
              ),
            ),
          );
      yield* writeCatalog(272_000, 1_000);
      yield* TestClock.adjust("10 seconds");
      const transcript = makeCodexReplayTranscript({
        scenario,
        entries: codexReplayPreamble({
          nativeThreadId: "native",
          nativeTurnId: "t",
          prompt: "x",
        }).slice(0, 3),
      });
      const driver = yield* CodexReplay.makeReplayDriver(transcript);
      const adapter = yield* CodexAdapter.makeCodexAdapterV2({
        instanceId: CodexAdapter.CODEX_DEFAULT_INSTANCE_ID,
        settings: yield* decodeCodexSettings({}),
        environment: { HOME: home },
        offeredModels: Effect.succeed([
          { slug: model, name: model, isCustom: false, capabilities: null },
        ]),
        clientFactory: {
          open: () =>
            Layer.build(CodexReplay.layerReplayWithDriver(driver)).pipe(
              Effect.map((context) => Context.get(context, CodexClient.CodexAppServerClient)),
              Effect.map((client): CodexClient.CodexAppServerClient["Service"] => ({
                ...client,
                request: ((method: string, params: unknown) => {
                  if (method === "model/list")
                    return Effect.succeed({ data: [{ model }], nextCursor: null });
                  if (method === "config/read") {
                    return Effect.succeed({ config: { model_catalog_json: "~/catalog.json" } });
                  }
                  return client.request(method as never, params as never);
                }) as typeof client.request,
              })),
              Effect.orDie,
            ),
        },
        crypto: yield* Crypto.Crypto,
        fileSystem: fs,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        serverConfig: yield* makeReplayServerConfig(scenario).pipe(Effect.orDie),
      }).pipe(Effect.provideService(CodexSurvivors.CodexSurvivors, noSurvivors));
      const runtime = yield* adapter.openSession({
        threadId: ThreadId.make("thread-catalog-freshness"),
        providerSessionId: ProviderSessionId.make("session"),
        modelSelection: CODEX_TEST_MODEL_SELECTION,
        runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
      });
      const modelStatus = runtime.modelStatus ?? (() => Effect.die("no model check"));

      assert.strictEqual(yield* modelStatus(model), "ready");
      yield* writeCatalog(1_048_576, 20_000);
      assert.strictEqual(yield* modelStatus(model), "outdated");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("retained process usage is not applied to the new home", () =>
  Effect.gen(function* () {
    const scenario = "retained-usage";
    const threadId = ThreadId.make("retained-usage");
    const transcript = makeCodexReplayTranscript({
      scenario,
      entries: codexReplayPreamble({
        nativeThreadId: "native",
        nativeTurnId: "turn",
        prompt: "x",
      }).slice(0, 3),
    });
    const driver = yield* CodexReplay.makeReplayDriver(transcript);
    let notify: ((payload: unknown) => Effect.Effect<void>) | undefined;
    const snapshot: ServerProvider = {
      instanceId: ProviderInstanceId.make("codex"),
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    };
    const provider = yield* makeManagedServerProvider({
      resolveMaintenance: () =>
        Effect.succeed({
          provider: ProviderDriverKind.make("codex"),
          packageName: "codex",
          update: { command: "codex", executable: "codex", args: [], lockKey: "codex" },
        }),
      getSettings: Effect.succeed({ enabled: true }),
      streamSettings: Stream.empty,
      haveSettingsChanged: (a, b) => a.enabled !== b.enabled,
      initialSnapshot: () => Effect.succeed(snapshot),
      checkProvider: Effect.succeed(snapshot),
      probeScope: () => "/home/B",
      currentScope: Effect.succeed("/home/B"),
      refreshOnInterval: false,
    }).pipe(
      Effect.provide(
        Layer.mock(ProviderHost.ProviderHost)({
          paths: {
            cwd: "/",
            baseDir: "/tmp",
            stateDir: "/tmp",
            providerStatusCacheDir: "/tmp",
            attachmentsDir: "/tmp",
          },
          resolveAttachmentPath: () => null,
          credentials: () => Effect.die("unused"),
          shouldRunBackgroundWork: () => Effect.succeed(false),
          settings: {
            get: Effect.succeed(DEFAULT_SERVER_SETTINGS),
            withSnapshot: (use) => use(DEFAULT_SERVER_SETTINGS),
            changes: Stream.empty,
            subscribe: Effect.succeed(Stream.empty),
          },
        }),
      ),
    );
    yield* provider.refresh;
    const adapter = yield* CodexAdapter.makeCodexAdapterV2({
      instanceId: CodexAdapter.CODEX_DEFAULT_INSTANCE_ID,
      settings: yield* decodeCodexSettings({}),
      environment: { CODEX_HOME: "/home/B" },
      onUsageLimits: provider.applyUsageLimits,
      clientFactory: {
        open: (input) =>
          Layer.build(CodexReplay.layerReplayWithDriver(driver)).pipe(
            Effect.tap(() => Effect.sync(() => input.onRetained?.())),
            Effect.map((context) => Context.get(context, CodexClient.CodexAppServerClient)),
            Effect.map((client): CodexClient.CodexAppServerClient["Service"] => ({
              ...client,
              handleServerNotification: (method, handler) =>
                Effect.sync(() => {
                  if (method === "account/rateLimits/updated")
                    notify = handler as (payload: unknown) => Effect.Effect<void>;
                }).pipe(Effect.andThen(client.handleServerNotification(method, handler))),
            })),
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterOpenSessionError({
                  driver: CodexAdapter.CODEX_DRIVER_KIND,
                  providerSessionId: input.providerSessionId,
                  cause,
                }),
            ),
          ),
      },
      crypto: yield* Crypto.Crypto,
      fileSystem: yield* FileSystem.FileSystem,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      serverConfig: yield* makeReplayServerConfig(scenario).pipe(Effect.orDie),
    }).pipe(Effect.provideService(CodexSurvivors.CodexSurvivors, noSurvivors));
    yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make("session"),
      modelSelection: CODEX_TEST_MODEL_SELECTION,
      runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
    });
    assert.isDefined(notify);
    if (notify)
      yield* notify({
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 50, resetsAt: 2000100000, windowDurationMins: 300 },
        },
      });
    assert.isUndefined((yield* provider.getSnapshot).usageLimits);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);
