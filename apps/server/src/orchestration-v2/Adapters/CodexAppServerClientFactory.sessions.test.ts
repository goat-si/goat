// @effect-diagnostics nodeBuiltinImport:off -- process records use an isolated temporary directory.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import {
  CodexSettings,
  ProviderInstanceId,
  ProviderSessionId,
  RunId,
  ThreadId,
} from "@goat/contracts";
import * as ProviderEventLoggers from "@goat/provider-core/server/ProviderEventLoggers";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import * as ServerSettings from "../../serverSettings.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as CodexSurvivors from "../../provider/CodexSurvivors.ts";
import { makeDetachedAppServers } from "../../provider/CodexDetachedAppServer.ts";
import { CodexDetachedAppServers } from "../../provider/CodexDetachedAppServerLive.ts";
import {
  CodexAppServerClientFactory,
  layerAppServerClientFactory,
} from "./CodexAppServerClientFactory.ts";

const codex = ProviderInstanceId.make("codex");
const sessionA = ProviderSessionId.make("session-a");
const sessionB = ProviderSessionId.make("session-b");
const defaultSettings = Schema.decodeSync(CodexSettings)({});

const recordFixture = (name: string, pgid: number, providerSessionId: string) => ({
  version: 1,
  name,
  instanceId: "codex",
  providerSessionId,
  socketPath: "/tmp/goat-factory-sessions-" + name + ".sock",
  pgid,
  bootId: "boot",
  state: "running",
  createdAt: "2026-01-01T00:00:00Z",
  stderrMode: "discard",
});

/** A factory over real preserved records; every recorded group lives until it is signalled. */
const harness = Effect.fn("CodexFactorySessionsTest.harness")(function* (
  records: ReadonlyArray<ReturnType<typeof recordFixture>>,
  services: {
    readonly survivors?: Layer.Layer<CodexSurvivors.CodexSurvivors>;
    readonly projections?: Layer.Layer<ProjectionStore.ProjectionStoreV2>;
  } = {},
) {
  const directory = yield* Effect.acquireRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-factory-sessions-"))),
    (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
  );
  const dir = NodePath.join(directory, "codex-app-servers");
  yield* Effect.promise(() => NodeFSP.mkdir(dir));
  for (const record of records)
    yield* Effect.promise(() =>
      NodeFSP.writeFile(NodePath.join(dir, record.name + ".json"), JSON.stringify(record)),
    );
  const gone = new Set<number>();
  const connected: string[] = [];
  let spawned = false;
  const detached = yield* makeDetachedAppServers({
    stateDir: directory,
    bootId: Effect.succeed("boot"),
    processTable: {
      groupMembers: (pgid) =>
        Effect.sync(() =>
          gone.has(pgid)
            ? []
            : records
                .filter((record) => record.pgid === pgid)
                .map((record) => ({ pid: pgid, pgid, argv: record.socketPath })),
        ),
      ownerOfSocket: () => Effect.void.pipe(Effect.as(undefined)),
    },
    socketAccepts: () => Effect.succeed(false),
    signalGroup: (pgid) =>
      Effect.sync(() => {
        gone.add(pgid);
      }),
    connect: (socketPath) =>
      Effect.sync(() => {
        connected.push(socketPath);
        return { incoming: Stream.never, send: () => Effect.void, closed: Effect.never };
      }),
  });
  yield* detached.loadRecords;
  for (const record of records) yield* detached.preserveForRecovery(record.name);
  const layer = layerAppServerClientFactory.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ServerSettings.ServerSettingsService)({}),
        services.projections ?? Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
        services.survivors ??
          Layer.mock(CodexSurvivors.CodexSurvivors)({
            get: () => Effect.void.pipe(Effect.as(undefined)),
          }),
        Layer.succeed(CodexDetachedAppServers, {
          ...detached,
          socketTransportEnabled: true,
          socketTransportMode: "socket" as const,
        }),
        Layer.mock(ChildProcessSpawner.ChildProcessSpawner)({
          spawn: () =>
            Effect.sync(() => {
              spawned = true;
            }).pipe(Effect.andThen(Effect.die("unexpected stdio"))),
        }),
        Layer.succeed(ProviderEventLoggers.ProviderEventLoggers, {
          native: undefined,
          canonical: undefined,
        }),
      ),
    ),
  );
  const open = (threadId: string, providerSessionId: ProviderSessionId) =>
    Effect.gen(function* () {
      const factory = yield* CodexAppServerClientFactory;
      return yield* factory.open({
        instanceId: codex,
        threadId: ThreadId.make(threadId),
        providerSessionId,
        runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: null },
        settings: defaultSettings,
        environment: {},
      });
    }).pipe(Effect.provide(layer));
  return { open, connected, spawned: () => spawned };
});

it.effect("each session reconnects to the preserved process its record names", () =>
  Effect.gen(function* () {
    const a = recordFixture("codex-aaaaaaaaaaaa", 1001, sessionA);
    const b = recordFixture("codex-bbbbbbbbbbbb", 1002, sessionB);
    const { open, connected, spawned } = yield* harness([a, b]);
    yield* Effect.gen(function* () {
      yield* open("thread-a", sessionA);
      yield* open("thread-b", sessionB);
    }).pipe(Effect.scoped);
    assert.deepEqual(connected, [a.socketPath, b.socketPath]);
    assert.isFalse(spawned());
  }).pipe(Effect.scoped),
);

it.effect.each([
  ["record", sessionA, sessionB],
  ["native thread", sessionB, sessionA],
] as const)(
  "a survivor whose %s belongs to another session fails closed without spawning",
  ([_case, recordSession, nativeSession]) =>
    Effect.gen(function* () {
      const record = recordFixture("codex-cccccccccccc", 1003, recordSession);
      const threadId = ThreadId.make("thread-survivor");
      const { open, connected, spawned } = yield* harness([record], {
        survivors: Layer.mock(CodexSurvivors.CodexSurvivors)({
          get: () =>
            Effect.succeed({
              instanceId: codex,
              threadId,
              recordName: record.name,
              providerSessionId: recordSession,
              sourceRunId: RunId.make("run-source"),
              nativeThreadId: "native-thread",
              nativeTurnId: "native-turn",
            }),
        }),
        projections: Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords: () =>
            Effect.succeed({
              providerThreads: [
                {
                  providerInstanceId: codex,
                  providerSessionId: nativeSession,
                  nativeThreadRef: { nativeId: "native-thread" },
                },
              ],
            } as never),
        }),
      });
      const result = yield* open(threadId, sessionB).pipe(Effect.scoped, Effect.exit);
      assert.equal(result._tag, "Failure");
      assert.deepEqual(connected, []);
      assert.isFalse(spawned());
    }).pipe(Effect.scoped),
);
