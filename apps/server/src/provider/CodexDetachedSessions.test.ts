// @effect-diagnostics nodeBuiltinImport:off -- process records use an isolated temporary directory.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import { ProviderSessionId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { makeDetachedAppServers } from "./CodexDetachedAppServer.ts";

const sessionA = ProviderSessionId.make("session-a");
const sessionB = ProviderSessionId.make("session-b");
const threadId = ThreadId.make("fenced-thread");

const recordFixture = (name: string, pgid: number, extra: object = {}) => ({
  version: 1,
  name,
  instanceId: "codex",
  socketPath: "/tmp/goat-sessions-" + name + ".sock",
  pgid,
  bootId: "boot",
  state: "running",
  createdAt: "2026-01-01T00:00:00Z",
  stderrMode: "discard",
  ...extra,
});

/** Records on disk, a process table where each group lives until it is signalled. */
const harness = Effect.fn("CodexDetachedSessionsTest.harness")(function* (
  records: ReadonlyArray<ReturnType<typeof recordFixture>>,
  pidFiles: Readonly<Record<string, string>> = {},
) {
  const directory = yield* Effect.acquireRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-sessions-"))),
    (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
  );
  const dir = NodePath.join(directory, "codex-app-servers");
  yield* Effect.promise(() => NodeFSP.mkdir(dir));
  for (const record of records)
    yield* Effect.promise(() =>
      NodeFSP.writeFile(NodePath.join(dir, record.name + ".json"), JSON.stringify(record)),
    );
  for (const [name, content] of Object.entries(pidFiles))
    yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(dir, name + ".pid"), content));
  const signals: Array<{ readonly pgid: number; readonly signal: string }> = [];
  const gone = new Set<number>();
  const connected: string[] = [];
  const service = yield* makeDetachedAppServers({
    stateDir: directory,
    bootId: Effect.succeed("boot"),
    processTable: {
      groupMembers: (pgid) =>
        Effect.sync(() => {
          const record = records.find((entry) => entry.pgid === pgid);
          return record === undefined || gone.has(pgid)
            ? []
            : [{ pid: pgid, pgid, argv: record.socketPath }];
        }),
      ownerOfSocket: () => Effect.void.pipe(Effect.as(undefined)),
    },
    socketAccepts: () => Effect.succeed(false),
    signalGroup: (pgid, signal) =>
      Effect.sync(() => {
        signals.push({ pgid, signal });
        gone.add(pgid);
      }),
    connect: (socketPath) =>
      Effect.sync(() => {
        connected.push(socketPath);
        return { incoming: Stream.never, send: () => Effect.void, closed: Effect.never };
      }),
  });
  const exists = (name: string) =>
    Effect.promise(() =>
      NodeFSP.access(NodePath.join(dir, name + ".json")).then(
        () => true,
        () => false,
      ),
    );
  return { service, signals, connected, exists };
});

it.effect("a blocked record blocks only the session it serves; an unassigned one blocks all", () =>
  Effect.gen(function* () {
    const keyed = recordFixture("codex-aaaaaaaaaaaa", 1001, { providerSessionId: sessionA });
    const { service } = yield* harness([keyed], { [keyed.name]: "not-a-pid" });
    assert.equal((yield* service.cleanup)[0]?.outcome, "blocked");
    const refused = yield* service.ensureNotBlocked("codex", sessionA).pipe(Effect.flip);
    assert.include(refused.message, "could not be stopped");
    yield* service.ensureNotBlocked("codex", sessionB);

    const legacy = recordFixture("codex-bbbbbbbbbbbb", 1002);
    const unassigned = yield* harness([legacy], { [legacy.name]: "not-a-pid" });
    assert.equal((yield* unassigned.service.cleanup)[0]?.outcome, "blocked");
    for (const session of [sessionA, sessionB])
      assert.equal(
        (yield* unassigned.service.ensureNotBlocked("codex", session).pipe(Effect.exit))._tag,
        "Failure",
      );
  }).pipe(Effect.scoped),
);

it.effect("a fenced process from before the upgrade without a session blocks its instance", () =>
  Effect.gen(function* () {
    const legacy = recordFixture("codex-cccccccccccc", 1003, {
      stopObligations: [{ threadId, nativeThreadId: "native", nativeTurnId: "turn" }],
    });
    const { service, signals } = yield* harness([legacy]);
    assert.equal((yield* service.cleanup)[0]?.outcome, "retained");
    assert.deepEqual(yield* service.listPreservedForSession("codex", sessionA), []);
    assert.equal(
      (yield* service.ensureNotBlocked("codex", sessionA).pipe(Effect.exit))._tag,
      "Failure",
    );
    yield* service.ensureNotBlocked("other", sessionA);
    assert.deepEqual(signals, []);
  }).pipe(Effect.scoped),
);

it.effect("each preserved process reconnects only for the session its record names", () =>
  Effect.gen(function* () {
    const a = recordFixture("codex-dddddddddddd", 1004, { providerSessionId: sessionA });
    const b = recordFixture("codex-eeeeeeeeeeee", 1005, { providerSessionId: sessionB });
    const { service, connected } = yield* harness([a, b]);
    yield* service.loadRecords;
    yield* service.preserveForRecovery(a.name);
    yield* service.preserveForRecovery(b.name);
    assert.deepEqual(yield* service.listPreservedForSession("codex", sessionA), [a.name]);
    assert.deepEqual(yield* service.listPreservedForSession("codex", sessionB), [b.name]);
    assert.deepEqual(yield* service.listPreservedForSession("other", sessionA), []);
    const refused = yield* service
      .connectExisting("codex", a.name, sessionB)
      .pipe(Effect.scoped, Effect.exit);
    assert.equal(refused._tag, "Failure");
    assert.deepEqual(connected, []);
  }).pipe(Effect.scoped),
);

it.effect("open records the provider session its process serves", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-session-open-"))),
      (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
    );
    const service = yield* makeDetachedAppServers({
      stateDir: directory,
      bootId: Effect.succeed("boot"),
      processTable: {
        groupMembers: () => Effect.succeed([]),
        ownerOfSocket: () => Effect.void.pipe(Effect.as(undefined)),
      },
      socketAccepts: () => Effect.succeed(false),
      signalGroup: () => Effect.void,
      socketDirectory: Effect.succeed("/tmp/goat-test/codex"),
      launch: () => Effect.succeed({ pid: 4321, exited: Effect.never }),
      connect: () =>
        Effect.succeed({ incoming: Stream.never, send: () => Effect.void, closed: Effect.never }),
    });
    const name = yield* service
      .open({
        instanceId: "codex",
        providerSessionId: sessionA,
        command: (path) => Effect.succeed({ command: "codex", args: [path] }),
      })
      .pipe(
        Effect.map((opened) => opened.record.name),
        Effect.tap(() => service.beginServerShutdown),
        Effect.scoped,
      );
    const stored = JSON.parse(
      yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(directory, "codex-app-servers", name + ".json"), "utf8"),
      ),
    );
    assert.equal(stored.providerSessionId, sessionA);
  }).pipe(Effect.scoped),
);

it.effect.each(["none", "stop"] as const)(
  "an adopted process is stopped and its record removed when its session closes (fences: %s)",
  (fence) =>
    Effect.gen(function* () {
      const record = recordFixture("codex-ffffffffffff", 1006, {
        providerSessionId: sessionA,
        ...(fence === "stop"
          ? { stopObligations: [{ threadId, nativeThreadId: "native", nativeTurnId: "turn" }] }
          : {}),
      });
      const { service, signals, exists } = yield* harness([record]);
      yield* service.loadRecords;
      yield* service.preserveForRecovery(record.name);
      // A status probe closes without a session and must leave the process alone.
      yield* service.connectExisting("codex", record.name).pipe(Effect.scoped);
      assert.deepEqual(signals, []);
      yield* service.connectExisting("codex", record.name, sessionA).pipe(Effect.scoped);
      assert.deepEqual(signals, [{ pgid: 1006, signal: "SIGTERM" }]);
      assert.isFalse(yield* exists(record.name));
      assert.deepEqual(yield* service.getStopObligations(threadId), []);
      assert.deepEqual(yield* service.listPreservedForSession("codex", sessionA), []);
      yield* service.ensureNotBlocked("codex", sessionA);
      yield* service.ensureAdmission(threadId);
    }).pipe(Effect.scoped),
);

it.effect("a goal-block process outlives its session and reconnects on the next open", () =>
  Effect.gen(function* () {
    const record = recordFixture("codex-gggggggggggg", 1007, {
      providerSessionId: sessionA,
      goalBlocks: [{ threadId, nativeThreadId: "native" }],
    });
    const { service, signals, connected, exists } = yield* harness([record]);
    assert.equal((yield* service.cleanup)[0]?.outcome, "retained");
    yield* service.connectExisting("codex", record.name, sessionA).pipe(Effect.scoped);
    assert.deepEqual(signals, []);
    assert.isTrue(yield* exists(record.name));
    yield* service.ensureNotBlocked("codex", sessionA);
    assert.deepEqual(yield* service.listPreservedForSession("codex", sessionA), [record.name]);
    yield* service.connectExisting("codex", record.name, sessionA).pipe(Effect.scoped);
    assert.equal(connected.length, 2);
    assert.deepEqual(signals, []);
  }).pipe(Effect.scoped),
);

it.effect("a status probe still open when shutdown begins leaves the process alone", () =>
  Effect.gen(function* () {
    const record = recordFixture("codex-hhhhhhhhhhhh", 1008, { providerSessionId: sessionA });
    const { service, signals, exists } = yield* harness([record]);
    yield* service.loadRecords;
    yield* service.preserveForRecovery(record.name);
    yield* Effect.gen(function* () {
      yield* service.connectExisting("codex", record.name);
      yield* service.beginServerShutdown;
    }).pipe(Effect.scoped);
    assert.deepEqual(signals, []);
    assert.isTrue(yield* exists(record.name));
    yield* service.connectExisting("codex", record.name, sessionA).pipe(Effect.scoped);
    assert.deepEqual(signals, [{ pgid: 1008, signal: "SIGTERM" }]);
  }).pipe(Effect.scoped),
);
