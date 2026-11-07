// @effect-diagnostics nodeBuiltinImport:off -- record fixtures use isolated temporary directories.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, RunId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Cause from "effect/Cause";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as CodexErrors from "effect-codex-app-server/errors";
import type * as CodexClient from "effect-codex-app-server/client";
import * as Layer from "effect/Layer";
import * as Detached from "./CodexDetachedAppServerLive.ts";
import { CodexDetachedAppServerError, makeDetachedAppServers } from "./CodexDetachedAppServer.ts";
import * as Survivors from "./CodexSurvivors.ts";
import * as Recovery from "../orchestration-v2/ProviderRuntimeRecoveryService.ts";
import { layerTest } from "../orchestration-v2/FoundationPersistence.testkit.ts";
import * as ServerSettings from "../serverSettings.ts";

it.effect(
  "survivor lookup retains the native turn and source run for its instance and thread",
  () =>
    Effect.gen(function* () {
      const service = yield* Survivors.CodexSurvivors;
      const binding = {
        instanceId: ProviderInstanceId.make("codex-a"),
        recordName: "codex-a-123456789abc",
        threadId: ThreadId.make("thread-a"),
        sourceRunId: RunId.make("run-a"),
        nativeThreadId: "native-thread-a",
        nativeTurnId: "native-turn-a",
      };
      yield* service.replace([binding]);
      assert.deepEqual(yield* service.get(binding.instanceId, binding.threadId), binding);
      assert.isUndefined(yield* service.get(ProviderInstanceId.make("codex-b"), binding.threadId));
      assert.deepEqual(yield* service.list, [binding]);
    }).pipe(
      Effect.provide(
        Survivors.layer.pipe(
          Layer.provide(
            Layer.mock(Detached.CodexDetachedAppServers)({ socketTransportEnabled: false }),
          ),
        ),
      ),
    ),
);

it.effect("an unreadable record permits startup while blocking Codex admission", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-survivors-"))),
      (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
    );
    const dir = NodePath.join(directory, "codex-app-servers");
    yield* Effect.promise(() => NodeFSP.mkdir(dir));
    yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(dir, "broken.json"), "null"));
    const service = yield* makeDetachedAppServers({
      stateDir: directory,
      bootId: Effect.succeed("boot"),
      processTable: {
        groupMembers: () => Effect.succeed([]),
        ownerOfSocket: () => Effect.void.pipe(Effect.as(undefined)),
      },
      socketAccepts: () => Effect.succeed(false),
      signalGroup: () => Effect.void,
    });
    assert.deepEqual(yield* service.loadRecords, []);
    const detachedLayer = Layer.succeed(Detached.CodexDetachedAppServers, {
      ...service,
      socketTransportEnabled: true,
    });
    const recoveryLayer = Recovery.layer.pipe(
      Layer.provideMerge(Survivors.layer),
      Layer.provideMerge(detachedLayer),
      Layer.provideMerge(layerTest),
      Layer.provideMerge(ServerSettings.layerTest()),
    );
    yield* Effect.gen(function* () {
      yield* (yield* Recovery.ProviderRuntimeRecoveryService).recover;
    }).pipe(Effect.provide(recoveryLayer));
    assert.equal(
      (yield* service.ensureAdmission(ThreadId.make("any-thread")).pipe(Effect.exit))._tag,
      "Failure",
    );
  }).pipe(Effect.scoped),
);

it.effect("goal threads are fenced before interrupt and never admitted as survivors", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const binding = {
      instanceId: ProviderInstanceId.make("codex"),
      recordName: "codex-123456789abc",
      threadId: ThreadId.make("thread-goal"),
      sourceRunId: RunId.make("run-goal"),
      nativeThreadId: "native-thread",
      nativeTurnId: "native-turn",
    };
    const result = yield* Survivors.classifyCandidate({
      binding,
      stopRequested: false,
      readGoal: Effect.succeed("goal" as const),
      recordGoal: () =>
        Effect.sync(() => {
          calls.push("goal");
        }),
      recordStop: () =>
        Effect.sync(() => {
          calls.push("fence");
        }),
      interrupt: () =>
        Effect.sync(() => {
          calls.push("interrupt");
        }),
      confirmTerminal: Effect.succeed(true),
    });
    assert.equal(result, "stopped");
    assert.deepEqual(calls, ["goal", "fence", "interrupt"]);
  }),
);

it.effect("a failed stop fence never sends an interrupt", () =>
  Effect.gen(function* () {
    let interrupted = false;
    const binding = {
      instanceId: ProviderInstanceId.make("codex"),
      recordName: "codex-123456789abc",
      threadId: ThreadId.make("thread-stop"),
      sourceRunId: RunId.make("run-stop"),
      nativeThreadId: "native-thread",
      nativeTurnId: "native-turn",
    };
    const result = yield* Survivors.classifyCandidate({
      binding,
      stopRequested: true,
      readGoal: Effect.succeed("none" as const),
      recordGoal: () => Effect.void,
      recordStop: () => Effect.fail(new CodexDetachedAppServerError({ detail: "write failed" })),
      interrupt: () =>
        Effect.sync(() => {
          interrupted = true;
        }),
      confirmTerminal: Effect.succeed(true),
    });
    assert.equal(result, "blocked");
    assert.isFalse(interrupted);
  }),
);

it.effect("a completed turn racing with Stop reports its confirmed outcome", () =>
  Effect.gen(function* () {
    const binding = {
      instanceId: ProviderInstanceId.make("codex"),
      recordName: "codex-123456789abc",
      threadId: ThreadId.make("thread"),
      sourceRunId: RunId.make("run"),
      nativeThreadId: "native",
      nativeTurnId: "turn",
    };
    const result = yield* Survivors.classifyCandidate({
      binding,
      stopRequested: true,
      readGoal: Effect.succeed("none" as const),
      recordGoal: () => Effect.void,
      recordStop: () => Effect.void,
      interrupt: () => Effect.void,
      confirmTerminal: Effect.succeed("completed" as const),
    });
    assert.equal(result, "completed");
  }),
);

it.effect("an interrupt error still settles a turn confirmed complete", () =>
  Effect.gen(function* () {
    const binding = {
      instanceId: ProviderInstanceId.make("codex"),
      recordName: "codex-123456789abc",
      threadId: ThreadId.make("thread"),
      sourceRunId: RunId.make("run"),
      nativeThreadId: "native",
      nativeTurnId: "turn",
    };
    let checked = false;
    const result = yield* Survivors.classifyCandidate({
      binding,
      stopRequested: true,
      readGoal: Effect.succeed("none" as const),
      recordGoal: () => Effect.void,
      recordStop: () => Effect.void,
      interrupt: () => Effect.fail("no active turn"),
      confirmTerminal: Effect.sync(() => {
        checked = true;
        return "completed" as const;
      }),
    });
    assert.isTrue(checked);
    assert.equal(result, "completed");
  }),
);

it.effect(
  "disabled goals allow survival; unreadable goals remain blocked without native confirmation",
  () =>
    Effect.gen(function* () {
      const binding = {
        instanceId: ProviderInstanceId.make("codex"),
        recordName: "codex-abcdefabcdef",
        threadId: ThreadId.make("thread-a"),
        sourceRunId: RunId.make("run-a"),
        nativeThreadId: "native-a",
        nativeTurnId: "turn-a",
      };
      const calls: string[] = [];
      const actions = {
        binding,
        stopRequested: false,
        recordGoal: () =>
          Effect.sync(() => {
            calls.push("goal");
          }),
        recordStop: () =>
          Effect.sync(() => {
            calls.push("fence");
          }),
        interrupt: () =>
          Effect.sync(() => {
            calls.push("interrupt");
          }),
        confirmTerminal: Effect.succeed(false),
      };
      assert.equal(
        yield* Survivors.classifyCandidate({
          ...actions,
          readGoal: Effect.succeed("disabled" as const),
        }),
        "survivor",
      );
      assert.deepEqual(calls, []);
      assert.equal(
        yield* Survivors.classifyCandidate({
          ...actions,
          readGoal: Effect.fail(new CodexDetachedAppServerError({ detail: "unreadable" })),
        }),
        "blocked",
      );
      assert.deepEqual(calls, ["goal", "fence", "interrupt"]);
    }),
);

it.effect("only the explicit disabled-goals error is treated as no goal", () =>
  Effect.gen(function* () {
    const disabled = new CodexErrors.CodexAppServerRequestError({
      code: -32600,
      errorMessage: "goals feature is disabled",
    });
    const unknown = new CodexErrors.CodexAppServerRequestError({
      code: -32600,
      errorMessage: "goal lookup failed",
    });
    assert.equal(yield* Survivors.readGoalStatus(Effect.fail(disabled)), "disabled");
    assert.equal(yield* Survivors.readGoalStatus(Effect.succeed({ goal: null })), "none");
    assert.equal(
      yield* Survivors.readGoalStatus(Effect.succeed({ goal: { status: "paused" } })),
      "goal",
    );
    assert.equal(
      (yield* Survivors.readGoalStatus(Effect.fail(unknown)).pipe(Effect.exit))._tag,
      "Failure",
    );
  }),
);

it.effect("goal fences release only for absent, paused, complete, or disabled goals", () =>
  Effect.gen(function* () {
    for (const status of ["paused", "complete"] as const)
      assert.equal(
        yield* Survivors.readGoalReleaseStatus(Effect.succeed({ goal: { status } })),
        "none",
      );
    for (const status of ["active", "blocked", "usageLimited", "budgetLimited"] as const)
      assert.equal(
        yield* Survivors.readGoalReleaseStatus(Effect.succeed({ goal: { status } })),
        "goal",
      );
  }),
);

it.effect("control classification installs a guard and fences before native interruption", () =>
  Effect.gen(function* () {
    const order: string[] = [];
    const binding = {
      instanceId: ProviderInstanceId.make("codex"),
      recordName: "codex-abcdefabcdef",
      threadId: ThreadId.make("thread"),
      sourceRunId: RunId.make("run"),
      nativeThreadId: "native",
      nativeTurnId: "turn",
    };
    const client = {
      setRequestGuard: () =>
        Effect.sync(() => {
          order.push("guard");
        }),
      handleServerNotification: () =>
        Effect.sync(() => {
          order.push("listen");
        }),
      request: (method: string) =>
        Effect.sync(() => {
          order.push(method);
          if (method === "thread/goal/get") return { goal: { status: "active" } };
          if (method === "thread/turns/list")
            return { data: [{ id: "turn", status: "interrupted" }] };
          return {};
        }),
    } as unknown as CodexClient.CodexAppServerClient["Service"];
    const result = yield* Survivors.classifyOnControl({
      client,
      binding,
      stopRequested: false,
      recordGoal: () =>
        Effect.sync(() => {
          order.push("goal-fence");
        }),
      recordStop: () =>
        Effect.sync(() => {
          order.push("stop-fence");
        }),
    });
    assert.equal(result, "stopped");
    assert.deepEqual(order, [
      "guard",
      "listen",
      "thread/goal/get",
      "goal-fence",
      "stop-fence",
      "thread/resume",
      "turn/interrupt",
      "thread/turns/list",
    ]);
  }),
);

it.effect("an unconfirmed startup interrupt keeps its durable fence", () =>
  Effect.gen(function* () {
    const binding = {
      instanceId: ProviderInstanceId.make("codex"),
      recordName: "codex-abcdefabcdef",
      threadId: ThreadId.make("thread"),
      sourceRunId: RunId.make("run"),
      nativeThreadId: "native",
      nativeTurnId: "turn",
    };
    const read = yield* Deferred.make<void>();
    let fence = false;
    const client = {
      setRequestGuard: () => Effect.void,
      handleServerNotification: () => Effect.void,
      request: (method: string) =>
        method === "thread/turns/list"
          ? Deferred.succeed(read, undefined).pipe(
              Effect.as({ data: [{ id: "turn", status: "inProgress" }] }),
            )
          : Effect.succeed(method === "thread/goal/get" ? { goal: null } : {}),
    } as unknown as CodexClient.CodexAppServerClient["Service"];
    const fiber = yield* Survivors.classifyOnControl({
      client,
      binding,
      stopRequested: true,
      recordGoal: () => Effect.void,
      recordStop: () =>
        Effect.sync(() => {
          fence = true;
        }),
    }).pipe(Effect.forkScoped);
    yield* Deferred.await(read);
    yield* TestClock.adjust("5 seconds");
    assert.equal(yield* Fiber.join(fiber), "blocked");
    assert.isTrue(fence);
  }).pipe(Effect.scoped),
);

it.effect("a verified control connection classifies a goal-free Codex turn", () =>
  Effect.gen(function* () {
    const incoming = yield* Queue.unbounded<string, Cause.Done<void>>();
    const methods: string[] = [];
    const channel = {
      incoming: Stream.fromQueue(incoming),
      closed: Effect.never,
      send: (message: string) =>
        Effect.gen(function* () {
          const request = JSON.parse(message) as { id?: number; method?: string };
          if (request.method) methods.push(request.method);
          if (request.id === undefined) return;
          const result =
            request.method === "initialize"
              ? {
                  codexHome: "/tmp",
                  platformFamily: "unix",
                  platformOs: "linux",
                  userAgent: "codex/0.163",
                }
              : { goal: null };
          yield* Queue.offer(incoming, JSON.stringify({ id: request.id, result }));
        }),
    };
    const binding = {
      instanceId: ProviderInstanceId.make("codex"),
      recordName: "codex-abcdefabcdef",
      threadId: ThreadId.make("thread"),
      sourceRunId: RunId.make("run"),
      nativeThreadId: "native",
      nativeTurnId: "turn",
    };
    const service = yield* Effect.service(Survivors.CodexSurvivors).pipe(
      Effect.provide(
        Survivors.layer.pipe(
          Layer.provide(
            Layer.mock(Detached.CodexDetachedAppServers)({
              socketTransportEnabled: true,
              connectExisting: () => Effect.succeed({ channel, record: {} as never }),
              recordGoalBlock: () => Effect.void.pipe(Effect.as(undefined)),
              recordStopObligation: () => Effect.void.pipe(Effect.as(undefined)),
            }),
          ),
        ),
      ),
    );
    assert.equal(yield* service.classifyExisting(binding, false), "survivor");
    assert.include(methods, "initialize");
    assert.include(methods, "thread/goal/get");
    assert.notInclude(methods, "turn/interrupt");
  }).pipe(Effect.scoped),
);

it.effect(
  "record classification is read-only and fails closed for missing or unreadable records",
  () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-classify-record-")),
        ),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const dir = NodePath.join(directory, "codex-app-servers");
      const name = "codex-abcdefabcdef";
      const socket = "/tmp/goat-classify.sock";
      yield* Effect.promise(() => NodeFSP.mkdir(dir));
      const file = NodePath.join(dir, name + ".json");
      const content = JSON.stringify({
        version: 1,
        name,
        instanceId: "codex",
        socketPath: socket,
        pgid: 4321,
        bootId: "boot",
        state: "running",
        createdAt: "2026-01-01T00:00:00Z",
        stderrMode: "discard",
      });
      yield* Effect.promise(() => NodeFSP.writeFile(file, content));
      let members: ReadonlyArray<{ pid: number; pgid: number; argv: string }> = [
        { pid: 4321, pgid: 4321, argv: socket },
      ];
      let signals = 0;
      const detached = yield* makeDetachedAppServers({
        stateDir: directory,
        bootId: Effect.succeed("boot"),
        processTable: {
          groupMembers: () => Effect.sync(() => members),
          ownerOfSocket: () => Effect.void.pipe(Effect.as(undefined)),
        },
        socketAccepts: () => Effect.succeed(false),
        signalGroup: () =>
          Effect.sync(() => {
            signals++;
          }),
      });
      const key = { instanceId: ProviderInstanceId.make("codex"), recordName: name };
      yield* Effect.gen(function* () {
        const service = yield* Survivors.CodexSurvivors;
        assert.equal((yield* service.classifyRecord(key)).type, "verified");
        assert.equal(
          (yield* detached.classifyRecord({ ...key, instanceId: ProviderInstanceId.make("other") }))
            .type,
          "mismatch",
        );
        members = [];
        assert.equal((yield* service.classifyRecord(key)).type, "gone");
        yield* Effect.promise(() =>
          NodeFSP.writeFile(file, JSON.stringify({ ...JSON.parse(content), state: "spawning" })),
        );
        assert.equal((yield* service.classifyRecord(key)).type, "unverifiable");
        yield* Effect.promise(() => NodeFSP.writeFile(file, "null"));
        assert.equal((yield* service.classifyRecord(key)).type, "unverifiable");
        yield* Effect.promise(() => NodeFSP.rm(file));
        assert.equal((yield* service.classifyRecord(key)).type, "unverifiable");
        assert.equal(signals, 0);
      }).pipe(
        Effect.provide(
          Survivors.layer.pipe(
            Layer.provide(
              Layer.succeed(Detached.CodexDetachedAppServers, {
                ...detached,
                socketTransportEnabled: true,
              }),
            ),
          ),
        ),
      );
    }).pipe(Effect.scoped),
);

it.effect("shutdown retains each session's process for the thread running on it", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-shutdown-"))),
      (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
    );
    const dir = NodePath.join(directory, "codex-app-servers");
    yield* Effect.promise(() => NodeFSP.mkdir(dir));
    const sessions = ["a", "b"] as const;
    const recordFor = (key: (typeof sessions)[number], index: number) => ({
      version: 1,
      name: "codex-" + key.repeat(12),
      instanceId: "codex",
      providerSessionId: "session-" + key,
      socketPath: "/tmp/goat-shutdown-" + key + ".sock",
      pgid: 2001 + index,
      bootId: "boot",
      state: "running",
      createdAt: "2026-01-01T00:00:00Z",
      stderrMode: "discard",
    });
    const records = sessions.map(recordFor);
    for (const record of records)
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(dir, record.name + ".json"), JSON.stringify(record)),
      );
    const detached = yield* makeDetachedAppServers({
      stateDir: directory,
      bootId: Effect.succeed("boot"),
      processTable: {
        groupMembers: (pgid) =>
          Effect.succeed(
            records
              .filter((record) => record.pgid === pgid)
              .map((record) => ({ pid: pgid, pgid, argv: record.socketPath })),
          ),
        ownerOfSocket: () => Effect.void.pipe(Effect.as(undefined)),
      },
      socketAccepts: () => Effect.succeed(false),
      signalGroup: () => Effect.void,
    });
    yield* detached.loadRecords;
    for (const record of records) yield* detached.preserveForRecovery(record.name);
    const projections = {
      getRuntimeRecoveryProjection: (threadId: ThreadId) =>
        Effect.succeed({
          thread: { projectId: "project" },
          runs: [
            {
              id: "run-" + threadId,
              status: "running",
              activeAttemptId: "attempt-" + threadId,
              providerThreadId: "provider-" + threadId,
              providerInstanceId: "codex",
            },
          ],
          providerThreads: [
            {
              id: "provider-" + threadId,
              driver: "codex",
              providerSessionId: "session-" + threadId,
            },
          ],
        }),
      getThreadRecords: (threadId: ThreadId) =>
        Effect.succeed({
          providerTurns: [{ runAttemptId: "attempt-" + threadId, ordinal: 1, status: "running" }],
        }),
    };
    const protect = { threads: new Set<ThreadId>(), sessions: new Set<string>() };
    yield* Survivors.prepareShutdownSurvivors({
      detached: { ...detached, socketTransportEnabled: true },
      projections: projections as never,
      sink: { writeWithEffects: () => Effect.void } as never,
      settings: yield* ServerSettings.ServerSettingsService.pipe(
        Effect.provide(ServerSettings.layerTest({ codexTurnsSurviveServerStop: "restart" })),
      ),
      stopKind: "restart",
      bindings: [],
      threadIds: sessions.map((key) => ThreadId.make(key)),
      protect,
    });
    assert.deepEqual([...protect.threads].sort(), ["a", "b"]);
    assert.deepEqual([...protect.sessions].sort(), ["session-a", "session-b"]);
  }).pipe(Effect.scoped),
);
