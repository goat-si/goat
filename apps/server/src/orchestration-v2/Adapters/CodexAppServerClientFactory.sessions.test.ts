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
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";

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

const recordFixture = (
  name: string,
  pgid: number,
  providerSessionId: string,
  fences: {
    readonly goalBlocks?: ReadonlyArray<{ threadId: string; nativeThreadId: string }>;
    readonly state?: "spawning" | "running";
  } = {},
) => ({
  version: 1,
  name,
  instanceId: "codex",
  providerSessionId,
  socketPath: "/tmp/goat-factory-sessions-" + name + ".sock",
  pgid,
  bootId: "boot",
  state: fences.state ?? "running",
  createdAt: "2026-01-01T00:00:00Z",
  stderrMode: "discard",
  ...(fences.goalBlocks === undefined ? {} : { goalBlocks: fences.goalBlocks }),
});

type Member = { readonly pid: number; readonly pgid: number; readonly argv: string };

/**
 * A factory over real preserved records; every recorded group lives until it is signalled or
 * `members` replaces what the process table reports for it.
 */
const harness = Effect.fn("CodexFactorySessionsTest.harness")(function* (
  records: ReadonlyArray<ReturnType<typeof recordFixture>>,
  services: {
    readonly survivors?: Layer.Layer<CodexSurvivors.CodexSurvivors>;
    readonly projections?: Layer.Layer<ProjectionStore.ProjectionStoreV2>;
    readonly socketAccepts?: (path: string) => Effect.Effect<boolean>;
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
  const members = new Map<number, ReadonlyArray<Member>>();
  const control: { gate: Effect.Effect<void> } = { gate: Effect.void };
  const connected: string[] = [];
  const launched: string[] = [];
  let spawned = false;
  const detached = yield* makeDetachedAppServers({
    stateDir: directory,
    bootId: Effect.succeed("boot"),
    processTable: {
      groupMembers: (pgid) =>
        Effect.suspend(() => control.gate).pipe(
          Effect.map(() =>
            gone.has(pgid)
              ? []
              : (members.get(pgid) ??
                records
                  .filter((record) => record.pgid === pgid)
                  .map((record) => ({ pid: pgid, pgid, argv: record.socketPath }))),
          ),
        ),
      ownerOfSocket: () => Effect.void.pipe(Effect.as(undefined)),
    },
    socketAccepts: services.socketAccepts ?? (() => Effect.succeed(false)),
    signalGroup: (pgid) =>
      Effect.sync(() => {
        gone.add(pgid);
      }),
    connect: (socketPath) =>
      Effect.sync(() => {
        connected.push(socketPath);
        return { incoming: Stream.never, send: () => Effect.void, closed: Effect.never };
      }),
    socketDirectory: Effect.succeed("/tmp/goat-factory-sessions"),
    launch: (input) =>
      Effect.sync(() => {
        launched.push(input.args.join(" "));
        return { pid: 9000 + launched.length, exited: Effect.never };
      }),
  });
  yield* detached.loadRecords;
  for (const record of records)
    yield* detached.preserveForRecovery(record.name).pipe(Effect.ignore);
  const layer = layerAppServerClientFactory.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ServerSettings.ServerSettingsService)({}),
        services.projections ?? Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
        services.survivors ??
          Layer.mock(CodexSurvivors.CodexSurvivors)({
            get: () => Effect.void.pipe(Effect.as(undefined)),
            list: Effect.succeed([]),
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
  const recordFiles = Effect.promise(() => NodeFSP.readdir(dir)).pipe(
    Effect.map((files) => files.filter((file) => file.endsWith(".json")).sort()),
  );
  return {
    open,
    detached,
    control,
    connected,
    launched,
    members,
    gone,
    recordFiles,
    spawned: () => spawned,
  };
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

const freshSocket = (launch: string | undefined) => /unix:\/\/(\S+)/.exec(launch ?? "")?.[1];

it.effect("a kept process that exited is retired and the session starts a fresh app-server", () =>
  Effect.gen(function* () {
    // Incident G16: the record still says running, its group has no members, its socket refuses.
    const kept = recordFixture("codex-6d127e4774a6", 18088, sessionA);
    const { open, connected, launched, gone, recordFiles } = yield* harness([kept]);
    gone.add(kept.pgid);
    yield* Effect.gen(function* () {
      yield* open("thread-a", sessionA);
      assert.equal(launched.length, 1);
      assert.deepEqual(connected, [freshSocket(launched[0])]);
      assert.notInclude(yield* recordFiles, kept.name + ".json");
    }).pipe(Effect.scoped);
    yield* open("thread-b", sessionA).pipe(Effect.scoped);
    assert.equal(launched.length, 2);
  }).pipe(Effect.scoped),
);

it.effect.each([
  ["a live process GOAT cannot verify", "accepting", [] as ReadonlyArray<Member>],
  ["a reused group id", "refusing", [{ pid: 1006, pgid: 1006, argv: "/usr/bin/other" }]],
  ["leftovers in the exited group", "refusing", [{ pid: 4242, pgid: 1006, argv: "helper" }]],
] as const)("%s refuses without replacing or signalling it", ([_case, socket, table]) =>
  Effect.gen(function* () {
    const kept = recordFixture("codex-eeeeeeeeeeee", 1006, sessionA);
    let after = false;
    const { open, connected, launched, members, gone, recordFiles } = yield* harness([kept], {
      socketAccepts: () => Effect.sync(() => after && socket === "accepting"),
    });
    after = true;
    members.set(kept.pgid, table);
    const opening = yield* open("thread-a", sessionA).pipe(
      Effect.scoped,
      Effect.flip,
      Effect.forkScoped,
    );
    yield* TestClock.adjust("3 seconds");
    const error = yield* Fiber.join(opening);
    assert.include(String(error.cause), "process group 1006");
    assert.deepEqual([connected, launched, [...gone]], [[], [], []]);
    assert.deepEqual(yield* recordFiles, [kept.name + ".json"]);
  }).pipe(Effect.scoped),
);

it.effect("a kept process that is still exiting is retired once its group is gone", () =>
  Effect.gen(function* () {
    const kept = recordFixture("codex-ffffffffffff", 1007, sessionA);
    const probed = yield* Deferred.make<void>();
    let phase: "alive" | "exiting" | "gone" = "alive";
    const { open, launched, members, recordFiles } = yield* harness([kept], {
      socketAccepts: () =>
        phase === "exiting"
          ? Deferred.succeed(probed, undefined).pipe(Effect.as(true))
          : Effect.succeed(false),
    });
    phase = "exiting";
    members.set(kept.pgid, []);
    yield* Effect.gen(function* () {
      const opening = yield* open("thread-a", sessionA).pipe(Effect.forkScoped);
      yield* Deferred.await(probed);
      phase = "gone";
      yield* TestClock.adjust("250 millis");
      yield* Fiber.join(opening);
      assert.equal(launched.length, 1);
      assert.notInclude(yield* recordFiles, kept.name + ".json");
    }).pipe(Effect.scoped);
  }).pipe(Effect.scoped),
);

it.effect("an exited process keeps its goal fence for that thread while others start anew", () =>
  Effect.gen(function* () {
    const kept = recordFixture("codex-111111111111", 1008, sessionA, {
      goalBlocks: [{ threadId: "thread-goal", nativeThreadId: "native-goal" }],
    });
    const { open, launched, gone, recordFiles } = yield* harness([kept]);
    gone.add(kept.pgid);
    const refused = yield* open("thread-goal", sessionA).pipe(Effect.scoped, Effect.flip);
    assert.include(String(refused.cause), "this thread's turn");
    assert.equal(launched.length, 0);
    yield* Effect.gen(function* () {
      yield* open("thread-other", sessionA);
      assert.equal(launched.length, 1);
      assert.include(yield* recordFiles, kept.name + ".json");
    }).pipe(Effect.scoped);
  }).pipe(Effect.scoped),
);

it.effect("a record still spawning is never given up", () =>
  Effect.gen(function* () {
    const kept = recordFixture("codex-222222222222", 1009, sessionA, { state: "spawning" });
    const threadId = ThreadId.make("thread-spawning");
    // The group stays alive: nothing may connect to it, signal it or start beside it.
    const { open, connected, launched, gone, recordFiles } = yield* harness([kept], {
      survivors: Layer.mock(CodexSurvivors.CodexSurvivors)({
        get: () =>
          Effect.succeed({
            instanceId: codex,
            threadId,
            recordName: kept.name,
            providerSessionId: sessionA,
            sourceRunId: RunId.make("run-source"),
            nativeThreadId: "native-thread",
            nativeTurnId: "native-turn",
          }),
        list: Effect.succeed([]),
      }),
      projections: Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getThreadRecords: () =>
          Effect.succeed({
            providerThreads: [
              {
                providerInstanceId: codex,
                providerSessionId: sessionA,
                nativeThreadRef: { nativeId: "native-thread" },
              },
            ],
          } as never),
      }),
    });
    const result = yield* open(threadId, sessionA).pipe(Effect.scoped, Effect.exit);
    assert.equal(result._tag, "Failure");
    assert.deepEqual([connected, launched, [...gone]], [[], [], []]);
    assert.deepEqual(yield* recordFiles, [kept.name + ".json"]);
  }).pipe(Effect.scoped),
);

it.effect.each([
  ["another thread", "thread-goal"],
  ["the opening thread", "thread-other"],
] as const)(
  "a fence written for %s while the exited group is classified keeps the record",
  ([_case, fencedThread]) =>
    Effect.gen(function* () {
      const kept = recordFixture("codex-333333333333", 1010, sessionA);
      const { open, detached, control, launched, gone, recordFiles } = yield* harness([kept]);
      gone.add(kept.pgid);
      const paused = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      control.gate = Deferred.succeed(paused, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      const goal = { threadId: ThreadId.make(fencedThread), nativeThreadId: "native-goal" };
      yield* Effect.gen(function* () {
        const opening = yield* open("thread-other", sessionA).pipe(Effect.exit, Effect.forkScoped);
        yield* Deferred.await(paused);
        control.gate = Effect.void;
        yield* detached.recordGoalBlock({ instanceId: codex, recordName: kept.name }, goal);
        yield* Deferred.succeed(release, undefined);
        const opened = yield* Fiber.join(opening);
        const own = fencedThread === "thread-other";
        assert.equal(opened._tag, own ? "Failure" : "Success");
        assert.equal(launched.length, own ? 0 : 1);
        assert.include(yield* recordFiles, kept.name + ".json");
        assert.isTrue(yield* detached.hasGoalBlock(goal.threadId));
      }).pipe(Effect.scoped);
    }).pipe(Effect.scoped),
);
