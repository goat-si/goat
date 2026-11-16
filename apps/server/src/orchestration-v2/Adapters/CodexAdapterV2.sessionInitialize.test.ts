import * as MemoryDerivedCache from "../../memory/MemoryDerivedCache.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CodexSettings,
  EnvironmentId,
  ProviderSessionId,
  ProviderSetupError,
  ThreadId,
} from "@goat/contracts";
import { assert, describe, it } from "@effect/vitest";

import * as CodexClient from "effect-codex-app-server/client";

import * as CodexReplay from "effect-codex-app-server/replay";
import * as Deferred from "effect/Deferred";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import * as Schema from "effect/Schema";

import { makeCodexReplayTranscript } from "./CodexReplay.testkit.ts";

import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as ModelManifest from "../../provider/ModelManifest.ts";
import { resolveProviderCompatibility } from "../../provider/providerCompatibility.ts";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import {
  CODEX_TEST_MODEL_SELECTION,
  CODEX_TEST_RUNTIME_POLICY,
  makeReplayServerConfig,
  withReplayRequestId,
} from "./CodexAdapterV2.testkit.ts";
import { codexReplayPreamble } from "./CodexAdapterV2.replay.testkit.ts";
import { withConfigReads } from "./CodexReplay.testkit.ts";

const layerAdapterTest = Layer.mergeAll(
  MemoryDerivedCache.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  NodeServices.layer,
);

const decodeThreadConfig = Schema.decodeUnknownEffect(
  Schema.Struct({ config: Schema.Record(Schema.String, Schema.Unknown) }),
);

const DEFAULT_CODEX_SETTINGS = Schema.decodeSync(CodexSettings)({});

describe("CodexAdapterV2 session initialize", () => {
  const openReplaySession = (
    transcript: CodexReplay.CodexAppServerReplayTranscript,
    beforeEmitInbound?: CodexReplay.CodexAppServerReplayDriver["beforeEmitInbound"],
    ownerThreadId?: ThreadId,
    compatibility?: CodexAdapterV2.CodexAdapterV2Options["compatibility"],
  ) =>
    Effect.gen(function* () {
      const driver = yield* CodexReplay.makeReplayDriver(
        withConfigReads(transcript),
        beforeEmitInbound === undefined ? {} : { beforeEmitInbound },
      );
      let initializeRequests = 0;
      let processEnvironment: NodeJS.ProcessEnv = {};
      const threadConfigs: unknown[] = [];
      const adapter = yield* CodexAdapterV2.makeCodexAdapterV2({
        instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
        settings: DEFAULT_CODEX_SETTINGS,
        environment: {},
        ...(compatibility === undefined ? {} : { compatibility }),
        clientFactory: {
          open: (openInput) =>
            Effect.sync(() => {
              processEnvironment = openInput.environment;
            }).pipe(
              Effect.andThen(Layer.build(CodexReplay.layerReplayWithDriver(driver))),
              Effect.flatMap((context) =>
                Effect.service(CodexClient.CodexAppServerClient).pipe(Effect.provide(context)),
              ),
              Effect.map(
                (client) =>
                  ({
                    ...client,
                    request: (method, params) =>
                      Effect.sync(() => {
                        if (method === "initialize") initializeRequests++;
                        if (method === "thread/start") threadConfigs.push(params);
                      }).pipe(Effect.andThen(client.request(method, params))),
                  }) satisfies CodexClient.CodexAppServerClient["Service"],
              ),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterOpenSessionError({
                    driver: CodexAdapterV2.CODEX_DRIVER_KIND,
                    providerSessionId: openInput.providerSessionId,
                    cause,
                  }),
              ),
            ),
        },
        crypto: yield* Crypto.Crypto,
        fileSystem: yield* FileSystem.FileSystem,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        serverConfig: yield* makeReplayServerConfig(transcript.scenario).pipe(Effect.orDie),
      });
      const runtime = yield* adapter.openSession({
        threadId: ownerThreadId ?? ThreadId.make(`thread-${transcript.scenario}`),
        providerSessionId: ProviderSessionId.make(`provider-session-${transcript.scenario}`),
        modelSelection: CODEX_TEST_MODEL_SELECTION,
        runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
      });
      return {
        ensureThread: (threadId: string) =>
          runtime.ensureThread({
            threadId: ThreadId.make(threadId),
            modelSelection: CODEX_TEST_MODEL_SELECTION,
            runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
          }),
        initializeRequests: () => initializeRequests,
        processEnvironment: () => processEnvironment,
        threadConfigs,
      };
    });

  const replayPreamble = (nativeThreadId: string) =>
    codexReplayPreamble({ nativeThreadId, nativeTurnId: "unused", prompt: "unused" });

  it.effect("isolates credentials for two threads sharing a Codex process (#934)", () =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      for (const name of ["first", "second"])
        yield* sessions.set({
          environmentId: EnvironmentId.make("fixture"),
          threadId: ThreadId.make(`thread-concurrent-${name}`),
          providerInstanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
          providerSessionId: `credential-${name}`,
          endpoint: "http://127.0.0.1:43123/mcp",
          authorizationHeader: `Bearer fixture-${name}`,
          temporaryDirectory: `/tmp/goat-threads-fixture/${name}`,
          browserToolsAvailable: false,
        });
      const initializeAwaitingResponse = yield* Deferred.make<void>();
      const releaseInitialize = yield* Deferred.make<void>();
      // Codex rejects a second initialize; the replay permits one handshake.
      const session = yield* openReplaySession(
        makeCodexReplayTranscript({
          scenario: "concurrent-initialize",
          entries: [
            ...replayPreamble("concurrent-first").slice(0, 5),
            ...replayPreamble("concurrent-second")
              .slice(3, 5)
              .map((entry) => withReplayRequestId(entry, 3)),
          ],
        }),
        (entry) =>
          entry.label === "initialize"
            ? Deferred.succeed(initializeAwaitingResponse, undefined).pipe(
                Effect.andThen(Deferred.await(releaseInitialize)),
              )
            : Effect.void,
        ThreadId.make("thread-concurrent-first"),
      );

      const first = yield* session
        .ensureThread("thread-concurrent-first")
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(initializeAwaitingResponse);
      const second = yield* session
        .ensureThread("thread-concurrent-second")
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(releaseInitialize, undefined);

      const providerThreads = [yield* Fiber.join(first), yield* Fiber.join(second)];
      assert.equal(session.initializeRequests(), 1);
      assert.equal(session.processEnvironment().GOAT_ACP_MCP_AUTHORIZATION, "");
      const temporaryDirectories = new Set<unknown>();
      for (const [index, name] of ["first", "second"].entries()) {
        const { config } = yield* decodeThreadConfig(session.threadConfigs[index]);
        temporaryDirectories.add(config["shell_environment_policy.set.TMPDIR"]);
        assert.equal(
          config["shell_environment_policy.set.GOAT_ACP_MCP_AUTHORIZATION"],
          `Bearer fixture-${name}`,
        );
        assert.equal(
          config["shell_environment_policy.set.GOAT_ACP_MCP_ENDPOINT"],
          "http://127.0.0.1:43123/mcp",
        );
      }
      assert.equal(temporaryDirectories.size, 2);
      assert.sameMembers(
        providerThreads.map((providerThread) => providerThread.nativeThreadRef?.nativeId),
        ["concurrent-first", "concurrent-second"],
      );
    }).pipe(Effect.scoped, Effect.provide(layerAdapterTest)),
  );

  it.effect("retries initialize after a failed handshake", () =>
    Effect.gen(function* () {
      const preamble = replayPreamble("initialize-retry");
      const entries: Array<CodexReplay.CodexAppServerReplayEntry> = [
        ...preamble.slice(0, 1),
        {
          type: "emit_inbound",
          label: "initialize",
          frame: { id: 1, error: { code: -32603, message: "Codex is not ready." } },
        },
        ...preamble.slice(0, 2).map((entry) => withReplayRequestId(entry, 2)),
        ...preamble.slice(2, 3),
        ...preamble.slice(3, 5).map((entry) => withReplayRequestId(entry, 3)),
      ];
      const session = yield* openReplaySession(
        makeCodexReplayTranscript({ scenario: "initialize-retry", entries }),
      );

      const failure = yield* session.ensureThread("thread-initialize-retry").pipe(Effect.flip);
      assert.equal(failure._tag, "ProviderAdapterEnsureThreadError");
      const providerThread = yield* session.ensureThread("thread-initialize-retry");
      assert.equal(providerThread.nativeThreadRef?.nativeId, "initialize-retry");
      assert.equal(session.initializeRequests(), 2);
    }).pipe(Effect.scoped, Effect.provide(layerAdapterTest)),
  );

  it.effect("refuses to open a session on a Codex version marked broken", () =>
    Effect.gen(function* () {
      const [initialize] = replayPreamble("broken-version");
      const failure = yield* openReplaySession(
        makeCodexReplayTranscript({
          scenario: "broken-version",
          entries: [
            initialize!,
            {
              type: "emit_inbound",
              label: "initialize",
              frame: {
                id: 1,
                result: {
                  userAgent: "T3 Code/0.144.3 (Mac OS 15.5.0; x86_64) unknown (T3 Code; 0.1.5)",
                  codexHome: "/tmp/codex-home",
                  platformFamily: "unix",
                  platformOs: "macos",
                },
              },
            },
          ],
        }),
        undefined,
        undefined,
        (version) =>
          Effect.succeed(
            resolveProviderCompatibility(
              ModelManifest.BUNDLED_MODEL_MANIFEST.compatibility,
              CodexAdapterV2.CODEX_DRIVER_KIND,
              version,
            ),
          ),
      ).pipe(Effect.flip);

      assert.instanceOf(failure, ProviderAdapter.ProviderAdapterOpenSessionError);
      assert.instanceOf(failure.cause, ProviderSetupError);
      assert.equal(
        failure.cause.message,
        "Codex 0.144.3 does not work with this GOAT release. Update Codex to >=0.159.0, then retry.",
      );
    }).pipe(Effect.scoped, Effect.provide(layerAdapterTest)),
  );

  it.effect("completes the handshake after a caller is interrupted mid-initialize", () =>
    Effect.gen(function* () {
      const initializeAwaitingResponse = yield* Deferred.make<void>();
      const releaseInitialize = yield* Deferred.make<void>();
      const preamble = replayPreamble("initialize-interrupted");
      const session = yield* openReplaySession(
        makeCodexReplayTranscript({
          scenario: "initialize-interrupted",
          entries: [
            ...preamble.slice(0, 2),
            ...preamble.slice(0, 1).map((entry) => withReplayRequestId(entry, 2)),
            {
              type: "emit_inbound",
              label: "initialize-rejected",
              frame: { id: 2, error: { code: -32600, message: "Already initialized" } },
            },
            ...preamble.slice(2, 3),
            ...preamble.slice(3, 5).map((entry) => withReplayRequestId(entry, 3)),
          ],
        }),
        (entry) =>
          entry.label === "initialize"
            ? Deferred.succeed(initializeAwaitingResponse, undefined).pipe(
                Effect.andThen(Deferred.await(releaseInitialize)),
              )
            : Effect.void,
      );

      const interrupted = yield* session
        .ensureThread("thread-initialize-interrupted")
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(initializeAwaitingResponse);
      yield* Fiber.interrupt(interrupted);
      yield* Deferred.succeed(releaseInitialize, undefined);

      const providerThread = yield* session.ensureThread("thread-initialize-interrupted");
      assert.equal(providerThread.nativeThreadRef?.nativeId, "initialize-interrupted");
      assert.equal(session.initializeRequests(), 2);
    }).pipe(Effect.scoped, Effect.provide(layerAdapterTest)),
  );
});
