import { assert, it } from "@effect/vitest";
import {
  CodexSettings,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@goat/contracts";
import * as ProviderEventLoggers from "@goat/provider-core/server/ProviderEventLoggers";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";

import * as ServerSettings from "../../serverSettings.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as CodexSurvivors from "../../provider/CodexSurvivors.ts";
import { CodexDetachedAppServerError } from "../../provider/CodexDetachedAppServer.ts";
import {
  CodexDetachedAppServers,
  shouldUseCodexSocketTransport,
} from "../../provider/CodexDetachedAppServerLive.ts";
import {
  CodexAppServerClientFactory,
  layerAppServerClientFactory,
  makeCodexAppServerProtocolLogger,
} from "./CodexAppServerClientFactory.ts";

const defaultSettings = Schema.decodeSync(CodexSettings)({});

it.effect("a socket attempt that leaves an unstoppable process refuses the stdio fallback", () =>
  Effect.gen(function* () {
    let blockChecks = 0;
    let spawned = false;
    const layer = layerAppServerClientFactory.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ServerSettings.ServerSettingsService)({}),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
          Layer.mock(CodexDetachedAppServers)({
            socketTransportEnabled: true,
            socketTransportMode: "socket",
            listPreservedForSession: () => Effect.succeed([]),
            open: () => Effect.fail(new CodexDetachedAppServerError({ detail: "not ready" })),
            ensureNotBlocked: () =>
              Effect.suspend(() =>
                ++blockChecks === 1
                  ? Effect.void
                  : Effect.fail(new CodexDetachedAppServerError({ detail: "still running" })),
              ),
          }),
          Layer.mock(ChildProcessSpawner.ChildProcessSpawner)({
            spawn: () =>
              Effect.sync(() => {
                spawned = true;
              }).pipe(Effect.andThen(Effect.die("stdio must not spawn"))),
          }),
          Layer.succeed(ProviderEventLoggers.ProviderEventLoggers, {
            native: undefined,
            canonical: undefined,
          }),
        ),
      ),
    );
    const error = yield* Effect.gen(function* () {
      const factory = yield* CodexAppServerClientFactory;
      return yield* factory
        .open({
          instanceId: ProviderInstanceId.make("codex"),
          threadId: ThreadId.make("thread-1"),
          providerSessionId: ProviderSessionId.make("session-1"),
          runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: null },
          settings: defaultSettings,
          environment: {},
        })
        .pipe(Effect.scoped, Effect.flip);
    }).pipe(Effect.provide(layer));
    assert.equal(error._tag, "ProviderAdapterOpenSessionError");
    assert.equal(blockChecks, 2);
    assert.isFalse(spawned);
  }),
);

it.effect("socket and stdio launches both cap Codex's jemalloc arenas", () =>
  Effect.gen(function* () {
    const launchEnvs: Array<NodeJS.ProcessEnv | undefined> = [];
    const layer = layerAppServerClientFactory.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ServerSettings.ServerSettingsService)({}),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
          Layer.mock(CodexDetachedAppServers)({
            socketTransportEnabled: true,
            socketTransportMode: "socket",
            listPreservedForSession: () => Effect.succeed([]),
            ensureNotBlocked: () => Effect.void,
            open: (input) =>
              Effect.sync(() => launchEnvs.push(input.env)).pipe(
                Effect.andThen(
                  Effect.fail(new CodexDetachedAppServerError({ detail: "no socket" })),
                ),
              ),
          }),
          Layer.mock(ChildProcessSpawner.ChildProcessSpawner)({
            spawn: (command) =>
              Effect.sync(() =>
                launchEnvs.push(
                  command._tag === "StandardCommand" ? command.options.env : undefined,
                ),
              ).pipe(Effect.andThen(Effect.die("observed stdio spawn"))),
          }),
          Layer.succeed(ProviderEventLoggers.ProviderEventLoggers, {
            native: undefined,
            canonical: undefined,
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const factory = yield* CodexAppServerClientFactory;
      yield* factory
        .open({
          instanceId: ProviderInstanceId.make("codex"),
          threadId: ThreadId.make("thread-1"),
          providerSessionId: ProviderSessionId.make("session-1"),
          runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: null },
          settings: defaultSettings,
          environment: {},
        })
        .pipe(Effect.scoped, Effect.exit);
    }).pipe(Effect.provide(layer));
    assert.deepEqual(
      launchEnvs.map((env) => env?._RJEM_MALLOC_CONF),
      ["narenas:2", "narenas:2"],
    );
  }),
);

it.effect("socket transport follows survival policy, override, and platform", () =>
  Effect.sync(() => {
    assert.isTrue(shouldUseCodexSocketTransport("auto", "restart"));
    assert.isTrue(shouldUseCodexSocketTransport("auto", "always"));
    assert.isFalse(shouldUseCodexSocketTransport("auto", "off"));
    assert.isTrue(shouldUseCodexSocketTransport("socket", "off"));
    assert.isFalse(shouldUseCodexSocketTransport("stdio", "always"));
    assert.isFalse(shouldUseCodexSocketTransport("unsupported", "always"));
  }),
);

it.effect("automatic transport uses the project survival setting before opening Codex", () =>
  Effect.gen(function* () {
    let socketAttempted = false;
    const layer = layerAppServerClientFactory.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed({
              ...DEFAULT_SERVER_SETTINGS,
              codexTurnsSurviveServerStop: "restart",
            }),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThread: () =>
              Effect.succeed({
                projectId: ProjectId.make("project-a"),
              } as OrchestrationV2AppThread),
          }),
          Layer.mock(CodexDetachedAppServers)({
            socketTransportEnabled: false,
            socketTransportMode: "auto",
            listPreservedForSession: () => Effect.succeed([]),
            ensureNotBlocked: () => Effect.void,
            open: () =>
              Effect.sync(() => {
                socketAttempted = true;
              }).pipe(Effect.andThen(Effect.die("observed socket attempt"))),
          }),
          Layer.mock(ChildProcessSpawner.ChildProcessSpawner)({
            spawn: () => Effect.die("unexpected stdio"),
          }),
          Layer.succeed(ProviderEventLoggers.ProviderEventLoggers, {
            native: undefined,
            canonical: undefined,
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const factory = yield* CodexAppServerClientFactory;
      yield* factory
        .open({
          instanceId: ProviderInstanceId.make("codex"),
          threadId: ThreadId.make("thread-a"),
          providerSessionId: ProviderSessionId.make("session-a"),
          runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: null },
          settings: defaultSettings,
          environment: {},
        })
        .pipe(Effect.scoped, Effect.exit);
    }).pipe(Effect.provide(layer));
    assert.isTrue(socketAttempted);
  }),
);

it.effect("an identified survivor never falls back to a new Codex process", () =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make("codex");
    const threadId = ThreadId.make("thread-survivor");
    let attempts = 0;
    let spawned = false;
    const layer = layerAppServerClientFactory.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ServerSettings.ServerSettingsService)({}),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadRecords: () =>
              Effect.succeed({
                providerThreads: [
                  {
                    providerInstanceId: instanceId,
                    providerSessionId: ProviderSessionId.make("session"),
                    nativeThreadRef: { nativeId: "native-thread" },
                  },
                ],
              } as never),
          }),
          Layer.mock(CodexSurvivors.CodexSurvivors)({
            list: Effect.succeed([]),
            get: () =>
              Effect.succeed({
                instanceId,
                threadId,
                recordName: "codex-abcdefabcdef",
                sourceRunId: RunId.make("run-source"),
                nativeThreadId: "native-thread",
                nativeTurnId: "native-turn",
              }),
          }),
          Layer.mock(CodexDetachedAppServers)({
            settleKept: () => Effect.succeed("connect" as const),
            socketTransportEnabled: true,
            socketTransportMode: "socket",
            listPreservedForSession: () => Effect.succeed([]),
            ensureNotBlocked: () => Effect.void,
            connectExisting: () =>
              Effect.sync(() => {
                attempts++;
              }).pipe(
                Effect.andThen(
                  Effect.fail(new CodexDetachedAppServerError({ detail: "unverified" })),
                ),
              ),
            open: () =>
              Effect.sync(() => {
                spawned = true;
              }).pipe(Effect.andThen(Effect.die("unexpected launch"))),
          }),
          Layer.mock(ChildProcessSpawner.ChildProcessSpawner)({
            spawn: () => Effect.die("unexpected stdio"),
          }),
          Layer.succeed(ProviderEventLoggers.ProviderEventLoggers, {
            native: undefined,
            canonical: undefined,
          }),
        ),
      ),
    );
    const result = yield* Effect.gen(function* () {
      const factory = yield* CodexAppServerClientFactory;
      return yield* factory
        .open({
          instanceId,
          threadId,
          providerSessionId: ProviderSessionId.make("session"),
          runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: null },
          settings: defaultSettings,
          environment: {},
        })
        .pipe(Effect.scoped, Effect.exit);
    }).pipe(Effect.provide(layer));
    assert.equal(result._tag, "Failure");
    assert.equal(attempts, 1);
    assert.isFalse(spawned);
  }),
);

it.effect(
  "a goal-only retained instance reconnects for an unrelated session without spawning",
  () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("codex");
      let connected = 0;
      let spawned = false;
      const layer = layerAppServerClientFactory.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ServerSettings.ServerSettingsService)({}),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
            Layer.mock(CodexSurvivors.CodexSurvivors)({
              get: () => Effect.void.pipe(Effect.as(undefined)),
              list: Effect.succeed([]),
              listGoalBlocksByInstance: () =>
                Effect.succeed([
                  {
                    record: { instanceId, recordName: "codex-abcdefabcdef" },
                    block: {
                      threadId: ThreadId.make("goal-thread"),
                      nativeThreadId: "native-goal",
                    },
                  },
                ]),
            }),
            Layer.mock(CodexDetachedAppServers)({
              settleKept: () => Effect.succeed("connect" as const),
              socketTransportEnabled: true,
              socketTransportMode: "socket",
              ensureNotBlocked: () => Effect.void,
              listPreservedForSession: () => Effect.succeed(["codex-abcdefabcdef"]),
              connectExisting: (_instance, name) =>
                Effect.sync(() => {
                  connected++;
                  assert.equal(name, "codex-abcdefabcdef");
                }).pipe(
                  Effect.andThen(
                    Effect.fail(new CodexDetachedAppServerError({ detail: "test connection" })),
                  ),
                ),
              open: () =>
                Effect.sync(() => {
                  spawned = true;
                }).pipe(Effect.andThen(Effect.die("unexpected launch"))),
            }),
            Layer.mock(ChildProcessSpawner.ChildProcessSpawner)({
              spawn: () => Effect.die("unexpected stdio"),
            }),
            Layer.succeed(ProviderEventLoggers.ProviderEventLoggers, {
              native: undefined,
              canonical: undefined,
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const factory = yield* CodexAppServerClientFactory;
        yield* factory
          .open({
            instanceId,
            threadId: ThreadId.make("unrelated"),
            providerSessionId: ProviderSessionId.make("session"),
            runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: null },
            settings: defaultSettings,
            environment: {},
          })
          .pipe(Effect.scoped, Effect.exit);
      }).pipe(Effect.provide(layer));
      assert.equal(connected, 1);
      assert.isFalse(spawned);
    }),
);

it.effect("a preserved process reconnects after its last goal block clears", () =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make("codex");
    let connected = 0;
    const layer = layerAppServerClientFactory.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ServerSettings.ServerSettingsService)({}),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
          Layer.mock(CodexSurvivors.CodexSurvivors)({
            get: () => Effect.void.pipe(Effect.as(undefined)),
            list: Effect.succeed([]),
            listGoalBlocksByInstance: () => Effect.succeed([]),
          }),
          Layer.mock(CodexDetachedAppServers)({
            settleKept: () => Effect.succeed("connect" as const),
            socketTransportEnabled: true,
            socketTransportMode: "socket",
            ensureNotBlocked: () => Effect.void,
            listPreservedForSession: () => Effect.succeed(["codex-abcdefabcdef"]),
            connectExisting: () =>
              Effect.sync(() => {
                connected++;
              }).pipe(
                Effect.andThen(
                  Effect.fail(new CodexDetachedAppServerError({ detail: "test connection" })),
                ),
              ),
            open: () => Effect.die("unexpected launch"),
          }),
          Layer.mock(ChildProcessSpawner.ChildProcessSpawner)({
            spawn: () => Effect.die("unexpected stdio"),
          }),
          Layer.succeed(ProviderEventLoggers.ProviderEventLoggers, {
            native: undefined,
            canonical: undefined,
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const factory = yield* CodexAppServerClientFactory;
      yield* factory
        .open({
          instanceId,
          threadId: ThreadId.make("thread"),
          providerSessionId: ProviderSessionId.make("session"),
          runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: null },
          settings: defaultSettings,
          environment: {},
        })
        .pipe(Effect.scoped, Effect.exit);
    }).pipe(Effect.provide(layer));
    assert.equal(connected, 1);
  }),
);

function openRecordedProtocolLogger(input: {
  readonly threadId: ThreadId;
  readonly threadFor?: (nativeThreadId: string) => ThreadId | undefined;
}) {
  const writes: Array<{ readonly event: unknown; readonly threadId: ThreadId | null }> = [];
  const nativeEventLogger: ProviderEventLoggers.EventNdjsonLogger = {
    filePath: "/tmp/events.log",
    write: (event, threadId) =>
      Effect.sync(() => {
        writes.push({ event, threadId });
      }),
    close: () => Effect.void,
  };
  const protocolLogger = makeCodexAppServerProtocolLogger({
    nativeEventLogger,
    threadId: input.threadId,
    providerSessionId: ProviderSessionId.make("provider-session-shared"),
    ...(input.threadFor === undefined ? {} : { threadFor: input.threadFor }),
  });
  if (protocolLogger === undefined) {
    throw new Error("expected a protocol logger");
  }
  return { writes, protocolLogger };
}

function recordedNativeThreadId(event: unknown): string | undefined {
  return typeof event === "object" &&
    event !== null &&
    "nativeThreadId" in event &&
    typeof event.nativeThreadId === "string"
    ? event.nativeThreadId
    : undefined;
}

it.effect("writes each native thread id shape to the GOAT thread that owns it", () =>
  Effect.gen(function* () {
    const opener = ThreadId.make("thread-opener");
    const threadA = ThreadId.make("thread-a");
    const threadB = ThreadId.make("thread-b");
    const owners = new Map<string, ThreadId>([
      ["native-a", threadA],
      ["native-b", threadB],
      ["native-result", threadB],
      ["native-conversation", threadA],
      ["native-result-id", threadB],
    ]);
    const { writes, protocolLogger } = openRecordedProtocolLogger({
      threadId: opener,
      threadFor: (nativeThreadId) => owners.get(nativeThreadId),
    });
    const frames = [
      {
        nativeThreadId: "native-a",
        threadId: threadA,
        payload: { method: "thread/event", params: { threadId: "native-a" } },
      },
      {
        nativeThreadId: "native-b",
        threadId: threadB,
        payload: { method: "item/completed", params: { thread: { id: "native-b" } } },
      },
      {
        nativeThreadId: "native-result",
        threadId: threadB,
        payload: { method: "thread/start", result: { thread: { id: "native-result" } } },
      },
      {
        nativeThreadId: "native-conversation",
        threadId: threadA,
        payload: {
          method: "execCommandApproval",
          params: { conversationId: "native-conversation" },
        },
      },
      {
        nativeThreadId: "native-result-id",
        threadId: threadB,
        payload: { method: "thread/resume", result: { threadId: "native-result-id" } },
      },
      {
        nativeThreadId: "native-a",
        threadId: threadA,
        payload: {
          method: "thread/event",
          params: {
            threadId: "native-a",
            conversationId: "native-conversation",
            thread: { id: "native-b" },
          },
          result: { thread: { id: "native-result" }, threadId: "native-result-id" },
        },
      },
    ];
    for (const frame of frames) {
      yield* protocolLogger({
        direction: "incoming",
        stage: "decoded",
        payload: frame.payload,
      });
    }
    assert.deepEqual(
      writes.map((write) => ({
        threadId: write.threadId,
        nativeThreadId: recordedNativeThreadId(write.event),
      })),
      frames.map((frame) => ({
        threadId: frame.threadId,
        nativeThreadId: frame.nativeThreadId,
      })),
    );
  }),
);

it.effect("keeps an unattributed frame on the opener log and names a known native thread", () =>
  Effect.gen(function* () {
    const opener = ThreadId.make("thread-opener");
    const threadA = ThreadId.make("thread-a");
    const { writes, protocolLogger } = openRecordedProtocolLogger({
      threadId: opener,
      threadFor: (nativeThreadId) => (nativeThreadId === "native-a" ? threadA : undefined),
    });
    yield* protocolLogger({
      direction: "incoming",
      stage: "decoded",
      payload: { method: "thread/event", params: { threadId: "native-unknown" } },
    });
    yield* protocolLogger({
      direction: "incoming",
      stage: "decoded",
      payload: { method: "thread/event", params: { threadId: 12 } },
    });
    yield* protocolLogger({
      direction: "incoming",
      stage: "decode_failed",
      payload: { operation: "decode", method: "thread/event" },
    });
    assert.deepEqual(
      writes.map((write) => ({
        threadId: write.threadId,
        nativeThreadId: recordedNativeThreadId(write.event),
      })),
      [
        { threadId: opener, nativeThreadId: "native-unknown" },
        { threadId: opener, nativeThreadId: undefined },
        { threadId: opener, nativeThreadId: undefined },
      ],
    );
    assert.equal(
      writes[0] !== undefined &&
        typeof writes[0].event === "object" &&
        writes[0].event !== null &&
        "nativeThreadId" in writes[0].event,
      true,
    );
    for (const write of writes.slice(1)) {
      assert.equal(
        typeof write.event === "object" && write.event !== null && "nativeThreadId" in write.event,
        false,
      );
    }
  }),
);
