// @effect-diagnostics nodeBuiltinImport:off -- process records use an isolated temporary directory.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { makeDetachedAppServers } from "./CodexDetachedAppServer.ts";

const session = ProviderSessionId.make("session");

it.effect.each(["restart", "quit"] as const)(
  "shutdown signals only a non-retained process (%s)",
  (stopKind) =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-retain-"))),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      let socketPath = "";
      const signals: string[] = [];
      let gone = false;
      const service = yield* makeDetachedAppServers({
        stateDir: directory,
        bootId: Effect.succeed("boot"),
        processTable: {
          groupMembers: () =>
            Effect.sync(() => (gone ? [] : [{ pid: 4321, pgid: 4321, argv: socketPath }])),
          ownerOfSocket: () => Effect.void.pipe(Effect.as(undefined)),
        },
        socketAccepts: () => Effect.succeed(false),
        signalGroup: (_pgid, signal) =>
          Effect.sync(() => {
            signals.push(signal);
            gone = true;
          }),
        socketDirectory: Effect.succeed("/tmp/goat-test/codex"),
        launch: () => Effect.succeed({ pid: 4321, exited: Effect.never }),
        connect: () =>
          Effect.succeed({ incoming: Stream.never, send: () => Effect.void, closed: Effect.never }),
      });
      const name = yield* Effect.gen(function* () {
        const opened = yield* service.open({
          instanceId: "codex",
          providerSessionId: session,
          command: (path) =>
            Effect.sync(() => {
              socketPath = path;
              return { command: "codex", args: [path] };
            }),
        });
        assert.isFalse(
          yield* service.retainOnClose(opened.record.name, {
            setting: "off",
            stopKind: "restart",
            prepared: true,
          }),
        );
        assert.isFalse(
          yield* service.retainOnClose(opened.record.name, {
            setting: "restart",
            stopKind: "quit",
            prepared: true,
          }),
        );
        assert.isFalse(
          yield* service.retainOnClose(opened.record.name, {
            setting: "always",
            stopKind: "quit",
            prepared: false,
          }),
        );
        assert.equal(
          yield* service.retainOnClose(opened.record.name, {
            setting: "restart",
            stopKind,
            prepared: true,
          }),
          stopKind === "restart",
        );
        yield* service.beginServerShutdown;
        return opened.record.name;
      }).pipe(Effect.scoped);
      assert.deepEqual(signals, stopKind === "restart" ? [] : ["SIGTERM"]);
      assert.isTrue(
        yield* Effect.promise(() =>
          NodeFSP.access(NodePath.join(directory, "codex-app-servers", name + ".json")).then(
            () => true,
            () => false,
          ),
        ),
      );
    }).pipe(Effect.scoped),
);

it.effect("only verified discard-mode records can reconnect to an existing process", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-reattach-"))),
      (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
    );
    const dir = NodePath.join(directory, "codex-app-servers");
    yield* Effect.promise(() => NodeFSP.mkdir(dir));
    const name = "codex-abcdefabcdef";
    const socket = "/tmp/goat-test/codex/existing.sock";
    const record = {
      version: 1,
      name,
      instanceId: "codex",
      socketPath: socket,
      pgid: 4321,
      bootId: "boot",
      state: "running",
      createdAt: "2026-01-01T00:00:00Z",
      stderrMode: "discard",
    };
    yield* Effect.promise(() =>
      NodeFSP.writeFile(NodePath.join(dir, name + ".json"), JSON.stringify(record)),
    );
    let connected = 0;
    const service = yield* makeDetachedAppServers({
      stateDir: directory,
      bootId: Effect.succeed("boot"),
      processTable: {
        groupMembers: () => Effect.succeed([{ pid: 4321, pgid: 4321, argv: socket }]),
        ownerOfSocket: () => Effect.void.pipe(Effect.as(undefined)),
      },
      socketAccepts: () => Effect.succeed(false),
      signalGroup: () => Effect.void,
      connect: () =>
        Effect.sync(() => {
          connected++;
          return { incoming: Stream.never, send: () => Effect.void, closed: Effect.never };
        }),
    });
    yield* service.loadRecords;
    const connectedChannel = yield* service.connectExisting("codex", name).pipe(Effect.scoped);
    assert.isDefined(connectedChannel);
    assert.equal(connected, 1);
    yield* Effect.promise(() =>
      NodeFSP.writeFile(
        NodePath.join(dir, name + ".json"),
        JSON.stringify({ ...record, stderrMode: undefined }),
      ),
    );
    yield* service.loadRecords;
    assert.equal(
      (yield* service.connectExisting("codex", name).pipe(Effect.scoped, Effect.exit))._tag,
      "Failure",
    );
    assert.equal(connected, 1);
  }).pipe(Effect.scoped),
);

it.effect("cleanup preserves a verified process selected for recovery", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-recovery-"))),
      (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
    );
    const dir = NodePath.join(directory, "codex-app-servers");
    yield* Effect.promise(() => NodeFSP.mkdir(dir));
    const name = "codex-abcdefabcdef";
    const socket = "/tmp/goat-test/codex/preserved.sock";
    yield* Effect.promise(() =>
      NodeFSP.writeFile(
        NodePath.join(dir, name + ".json"),
        JSON.stringify({
          version: 1,
          name,
          instanceId: "codex",
          socketPath: socket,
          pgid: 4321,
          bootId: "boot",
          state: "running",
          createdAt: "2026-01-01T00:00:00Z",
          stderrMode: "discard",
        }),
      ),
    );
    yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(dir, name + ".pid"), "4321"));
    let signalled = false;
    const service = yield* makeDetachedAppServers({
      stateDir: directory,
      bootId: Effect.succeed("boot"),
      processTable: {
        groupMembers: () => Effect.succeed([{ pid: 4321, pgid: 4321, argv: socket }]),
        ownerOfSocket: () => Effect.void.pipe(Effect.as(undefined)),
      },
      socketAccepts: () => Effect.succeed(false),
      signalGroup: () =>
        Effect.sync(() => {
          signalled = true;
        }),
    });
    yield* service.loadRecords;
    yield* service.preserveForRecovery(name);
    assert.equal((yield* service.cleanup)[0]?.outcome, "retained");
    assert.isFalse(signalled);
    assert.isTrue(
      yield* Effect.promise(() =>
        NodeFSP.access(NodePath.join(dir, name + ".json")).then(
          () => true,
          () => false,
        ),
      ),
    );
  }).pipe(Effect.scoped),
);

it.effect.each(["restart", "quit"] as const)(
  "an adopted process follows the selected shutdown policy (%s)",
  (stopKind) =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-adopted-retain-")),
        ),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const dir = NodePath.join(directory, "codex-app-servers");
      const name = "codex-abcdefabcdef";
      const socket = "/tmp/goat-test/codex/adopted.sock";
      yield* Effect.promise(() => NodeFSP.mkdir(dir));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(dir, name + ".json"),
          JSON.stringify({
            version: 1,
            name,
            instanceId: "codex",
            socketPath: socket,
            pgid: 4321,
            bootId: "boot",
            state: "running",
            createdAt: "2026-01-01T00:00:00Z",
            stderrMode: "discard",
          }),
        ),
      );
      const signals: string[] = [];
      const service = yield* makeDetachedAppServers({
        stateDir: directory,
        bootId: Effect.succeed("boot"),
        processTable: {
          groupMembers: () => Effect.succeed([{ pid: 4321, pgid: 4321, argv: socket }]),
          ownerOfSocket: () => Effect.void.pipe(Effect.as(undefined)),
        },
        socketAccepts: () => Effect.succeed(false),
        signalGroup: (_pgid, signal) =>
          Effect.sync(() => {
            signals.push(signal);
          }),
        connect: () =>
          Effect.succeed({ incoming: Stream.never, send: () => Effect.void, closed: Effect.never }),
      });
      yield* service.loadRecords;
      yield* service.preserveForRecovery(name);
      yield* Effect.gen(function* () {
        yield* service.connectExisting("codex", name);
        if (stopKind === "restart")
          yield* service.retainOnClose(name, { setting: "restart", stopKind, prepared: true });
        yield* service.beginServerShutdown;
      }).pipe(Effect.scoped);
      assert.deepEqual(signals, stopKind === "restart" ? [] : ["SIGTERM"]);
    }).pipe(Effect.scoped),
);

it.effect.each(["goal", "stop"] as const)(
  "startup preserves a verified process with a durable %s fence",
  (kind) =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-fenced-cleanup-")),
        ),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const dir = NodePath.join(directory, "codex-app-servers");
      const name = "codex-abcdefabcdef";
      const socket = "/tmp/goat-fenced-test.sock";
      const threadId = ThreadId.make("fenced-thread");
      yield* Effect.promise(() => NodeFSP.mkdir(dir));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(dir, name + ".json"),
          JSON.stringify({
            version: 1,
            name,
            instanceId: "codex",
            socketPath: socket,
            pgid: 4321,
            bootId: "boot",
            state: "running",
            createdAt: "2026-01-01T00:00:00Z",
            stderrMode: "discard",
            providerSessionId: session,
            ...(kind === "goal"
              ? { goalBlocks: [{ threadId, nativeThreadId: "native" }] }
              : {
                  stopObligations: [{ threadId, nativeThreadId: "native", nativeTurnId: "turn" }],
                }),
          }),
        ),
      );
      let signals = 0;
      const service = yield* makeDetachedAppServers({
        stateDir: directory,
        bootId: Effect.succeed("boot"),
        processTable: {
          groupMembers: () => Effect.succeed([{ pid: 4321, pgid: 4321, argv: socket }]),
          ownerOfSocket: () => Effect.void.pipe(Effect.as(undefined)),
        },
        socketAccepts: () => Effect.succeed(false),
        signalGroup: () =>
          Effect.sync(() => {
            signals++;
          }),
      });
      assert.equal((yield* service.cleanup)[0]?.outcome, "retained");
      assert.deepEqual(yield* service.listPreservedForSession("codex", session), [name]);
      assert.deepEqual(yield* service.listPreservedForSession("other", session), []);
      assert.equal(signals, 0);
      assert.equal((yield* service.ensureAdmission(threadId).pipe(Effect.exit))._tag, "Failure");
      if (kind === "goal") {
        yield* service.clearGoalBlock(
          { instanceId: ProviderInstanceId.make("codex"), recordName: name },
          { threadId, nativeThreadId: "native" },
        );
        assert.deepEqual(yield* service.listPreservedForSession("codex", session), [name]);
      }
    }).pipe(Effect.scoped),
);
