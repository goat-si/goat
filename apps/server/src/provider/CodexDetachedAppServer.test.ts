// @effect-diagnostics nodeBuiltinImport:off -- fixtures use an isolated temporary record directory.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import {
  classifyDetachedAppServer,
  CodexDetachedAppServerError,
  makeDetachedAppServers,
  privateSocketDirectory,
} from "./CodexDetachedAppServer.ts";

const socketPath = "/tmp/goat-test/codex/unique.sock";
const record = {
  version: 1 as const,
  instanceId: "codex-instance",
  name: "codex-instance-0123456789ab",
  socketPath,
  pgid: 1234,
  bootId: "boot-one",
  state: "running" as const,
  createdAt: "2026-11-03T00:00:00.000Z",
};

const processTable = (members: ReadonlyArray<{ pid: number; pgid: number; argv: string }>) => ({
  groupMembers: (_pgid: number) => Effect.succeed(members),
  ownerOfSocket: (_socketPath: string) => Effect.void.pipe(Effect.as(undefined)),
});

it.effect("treats a reused group leader without the socket path as a mismatch", () =>
  Effect.gen(function* () {
    const result = yield* classifyDetachedAppServer(record, {
      processTable: processTable([{ pid: 1234, pgid: 1234, argv: "unrelated" }]),
      socketAccepts: () => Effect.succeed(false),
    });
    assert.equal(result.type, "mismatch");
  }),
);

it.effect("verifies a native child when its group leader has exited", () =>
  Effect.gen(function* () {
    const result = yield* classifyDetachedAppServer(record, {
      processTable: processTable([{ pid: 1235, pgid: 1234, argv: `codex --listen ${socketPath}` }]),
      socketAccepts: () => Effect.succeed(false),
    });
    assert.equal(result.type === "verified" ? result.pgid : undefined, 1234);
  }),
);

it.effect("does not verify leaderless processes without the unique socket path", () =>
  Effect.gen(function* () {
    const result = yield* classifyDetachedAppServer(record, {
      processTable: processTable([{ pid: 1235, pgid: 1234, argv: "tool command" }]),
      socketAccepts: () => Effect.succeed(false),
    });
    assert.equal(result.type, "gone");
  }),
);

it.effect("does not treat a process table read failure as a dead group", () =>
  Effect.gen(function* () {
    const result = yield* classifyDetachedAppServer(record, {
      processTable: {
        ...processTable([]),
        groupMembers: () =>
          Effect.fail(new CodexDetachedAppServerError({ detail: "process table unavailable" })),
      },
      socketAccepts: () => Effect.succeed(false),
    });
    assert.equal(result.type, "unverifiable");
  }),
);

it.effect("blocks when a socket accepts connections but its owner cannot be established", () =>
  Effect.gen(function* () {
    const result = yield* classifyDetachedAppServer(record, {
      processTable: processTable([]),
      socketAccepts: () => Effect.succeed(true),
    });
    assert.equal(result.type, "unverifiable");
  }),
);

it.effect("verifies the published process before its socket starts accepting connections", () =>
  Effect.gen(function* () {
    const result = yield* classifyDetachedAppServer(record, {
      processTable: processTable([
        { pid: 1234, pgid: 1234, argv: `codex app-server --listen unix://${socketPath}` },
      ]),
      socketAccepts: () => Effect.succeed(false),
    });
    assert.equal(result.type === "verified" ? result.pgid : undefined, 1234);
  }),
);

it.effect("reports a group as gone only when it is empty and its socket is dead", () =>
  Effect.gen(function* () {
    const result = yield* classifyDetachedAppServer(record, {
      processTable: processTable([]),
      socketAccepts: () => Effect.succeed(false),
    });
    assert.equal(result.type, "gone");
  }),
);

it.effect("blocks when socket ownership cannot be read", () =>
  Effect.gen(function* () {
    const result = yield* classifyDetachedAppServer(record, {
      processTable: {
        ...processTable([{ pid: 1234, pgid: 1234, argv: `codex ${socketPath}` }]),
        ownerOfSocket: () =>
          Effect.fail(new CodexDetachedAppServerError({ detail: "socket owner unavailable" })),
      },
      socketAccepts: () => Effect.succeed(true),
    });
    assert.equal(result.type, "unverifiable");
  }),
);

const withRecordDirectory = <A, E, R>(run: (directory: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-detached-test-")),
    );
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
    );
    return yield* run(directory);
  }).pipe(Effect.scoped);

it.effect("startup deletes a reused group record without signalling the unrelated leader", () =>
  withRecordDirectory((directory) =>
    Effect.gen(function* () {
      const dir = NodePath.join(directory, "codex-app-servers");
      yield* Effect.promise(() => NodeFSP.mkdir(dir));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(dir, `${record.name}.json`), JSON.stringify(record)),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(dir, `${record.name}.pid`), "1234"),
      );
      const signals: string[] = [];
      const service = yield* makeDetachedAppServers({
        stateDir: directory,
        bootId: Effect.succeed("boot-one"),
        processTable: processTable([{ pid: 1234, pgid: 1234, argv: "unrelated" }]),
        socketAccepts: () => Effect.succeed(false),
        signalGroup: (pgid: number, signal: string) =>
          Effect.sync(() => {
            signals.push(`${pgid}:${signal}`);
          }),
      });
      const outcomes = yield* service.cleanup;
      assert.deepEqual(signals, []);
      assert.equal(outcomes[0]?.outcome, "cleaned");
      assert.deepEqual(yield* Effect.promise(() => NodeFSP.readdir(dir)), []);
    }),
  ),
);

it.effect(
  "startup warns about leaderless possible leftovers and removes the record without signalling",
  () =>
    withRecordDirectory((directory) =>
      Effect.gen(function* () {
        const dir = NodePath.join(directory, "codex-app-servers");
        yield* Effect.promise(() => NodeFSP.mkdir(dir));
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(dir, `${record.name}.json`), JSON.stringify(record)),
        );
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(dir, `${record.name}.pid`), "1234"),
        );
        const signals: string[] = [];
        const warnings: ReadonlyArray<number>[] = [];
        const service = yield* makeDetachedAppServers({
          stateDir: directory,
          bootId: Effect.succeed("boot-one"),
          processTable: processTable([{ pid: 1235, pgid: 1234, argv: "tool command" }]),
          socketAccepts: () => Effect.succeed(false),
          signalGroup: (_pgid: number, signal: string) =>
            Effect.sync(() => {
              signals.push(signal);
            }),
          warnPossibleLeftovers: (pids: ReadonlyArray<number>) =>
            Effect.sync(() => {
              warnings.push(pids);
            }),
        });
        const outcomes = yield* service.cleanup;
        assert.equal(outcomes[0]?.outcome, "cleaned");
        assert.deepEqual(signals, []);
        assert.deepEqual(warnings, [[1235]]);
        assert.deepEqual(yield* Effect.promise(() => NodeFSP.readdir(dir)), []);
      }),
    ),
);

it.effect("an unpublished pid is claimed and retained until a different boot", () =>
  withRecordDirectory((directory) =>
    Effect.gen(function* () {
      const dir = NodePath.join(directory, "codex-app-servers");
      yield* Effect.promise(() => NodeFSP.mkdir(dir));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(dir, `${record.name}.json`),
          JSON.stringify({ ...record, state: "spawning", pgid: undefined }),
        ),
      );
      let bootId = "boot-one";
      const service = yield* makeDetachedAppServers({
        stateDir: directory,
        bootId: Effect.sync(() => bootId),
        processTable: processTable([]),
        socketAccepts: () => Effect.succeed(false),
        signalGroup: () => Effect.die("unexpected signal"),
      });
      const first = yield* service.cleanup;
      assert.equal(first[0]?.outcome, "tombstoned");
      assert.equal(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(dir, `${record.name}.pid`), "utf8"),
        ),
        "abandoned",
      );
      bootId = "boot-two";
      const second = yield* service.cleanup;
      assert.equal(second[0]?.outcome, "cleaned");
      assert.deepEqual(yield* Effect.promise(() => NodeFSP.readdir(dir)), []);
    }),
  ),
);

it.effect("a malformed pid blocks cleanup without deleting its evidence", () =>
  withRecordDirectory((directory) =>
    Effect.gen(function* () {
      const dir = NodePath.join(directory, "codex-app-servers");
      yield* Effect.promise(() => NodeFSP.mkdir(dir));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(dir, `${record.name}.json`), JSON.stringify(record)),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(dir, `${record.name}.pid`), "not-a-pid"),
      );
      const service = yield* makeDetachedAppServers({
        stateDir: directory,
        bootId: Effect.succeed("boot-one"),
        processTable: processTable([]),
        socketAccepts: () => Effect.succeed(false),
        signalGroup: () => Effect.die("unexpected signal"),
      });
      const outcomes = yield* service.cleanup;
      assert.equal(outcomes[0]?.outcome, "blocked");
      assert.deepEqual((yield* Effect.promise(() => NodeFSP.readdir(dir))).sort(), [
        `${record.name}.json`,
        `${record.name}.pid`,
      ]);
    }),
  ),
);

it.effect("a failed process lookup blocks opens until the stale group is demonstrably gone", () =>
  withRecordDirectory((directory) =>
    Effect.gen(function* () {
      const dir = NodePath.join(directory, "codex-app-servers");
      yield* Effect.promise(() => NodeFSP.mkdir(dir));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(dir, `${record.name}.json`), JSON.stringify(record)),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(dir, `${record.name}.pid`), "1234"),
      );
      let unavailable = true;
      const service = yield* makeDetachedAppServers({
        stateDir: directory,
        bootId: Effect.succeed("boot-one"),
        processTable: {
          ...processTable([]),
          groupMembers: () =>
            unavailable
              ? Effect.fail(
                  new CodexDetachedAppServerError({ detail: "process table unavailable" }),
                )
              : Effect.succeed([]),
        },
        socketAccepts: () => Effect.succeed(false),
        signalGroup: () => Effect.die("unexpected signal"),
      });
      const outcomes = yield* service.cleanup;
      assert.equal(outcomes[0]?.outcome, "blocked");
      const error = yield* service.ensureNotBlocked(record.instanceId).pipe(Effect.flip);
      assert.include(String(error), "could not be stopped");
      assert.deepEqual((yield* Effect.promise(() => NodeFSP.readdir(dir))).sort(), [
        `${record.name}.json`,
        `${record.name}.pid`,
      ]);
      unavailable = false;
      yield* service.ensureNotBlocked(record.instanceId);
      assert.deepEqual(yield* Effect.promise(() => NodeFSP.readdir(dir)), []);
    }),
  ),
);

it.effect("startup's atomic claim defeats a shell that has not published its pid", () =>
  withRecordDirectory((directory) =>
    Effect.gen(function* () {
      const dir = NodePath.join(directory, "codex-app-servers");
      yield* Effect.promise(() => NodeFSP.mkdir(dir));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(dir, `${record.name}.json`),
          JSON.stringify({ ...record, state: "spawning", pgid: undefined }),
        ),
      );
      const service = yield* makeDetachedAppServers({
        stateDir: directory,
        bootId: Effect.succeed("boot-one"),
        processTable: processTable([]),
        socketAccepts: () => Effect.succeed(false),
        signalGroup: () => Effect.die("unexpected signal"),
      });
      yield* service.cleanup;
      const temporary = NodePath.join(dir, `${record.name}.pid.shell`);
      yield* Effect.promise(() => NodeFSP.writeFile(temporary, "1234"));
      const linkCode = yield* Effect.promise(() =>
        NodeFSP.link(temporary, NodePath.join(dir, `${record.name}.pid`)).then(
          () => "linked",
          (cause: NodeJS.ErrnoException) => cause.code,
        ),
      );
      assert.equal(linkCode, "EEXIST");
      assert.equal(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(dir, `${record.name}.pid`), "utf8"),
        ),
        "abandoned",
      );
    }),
  ),
);

it.effect("server shutdown signals once and finishes without waiting for the clock", () =>
  withRecordDirectory((directory) =>
    Effect.gen(function* () {
      const signals: string[] = [];
      const service = yield* makeDetachedAppServers({
        stateDir: directory,
        bootId: Effect.succeed("boot-one"),
        processTable: processTable([{ pid: 1234, pgid: 1234, argv: `codex ${socketPath}` }]),
        socketAccepts: () => Effect.succeed(false),
        signalGroup: (_pgid: number, signal: string) =>
          Effect.sync(() => {
            signals.push(signal);
          }),
      });
      yield* service.beginServerShutdown;
      yield* service.close(record);
      assert.deepEqual(signals, ["SIGTERM"]);
    }),
  ),
);

it.effect("ordinary close escalates after five seconds and blocks if the group remains", () =>
  withRecordDirectory((directory) =>
    Effect.gen(function* () {
      const signals: string[] = [];
      const service = yield* makeDetachedAppServers({
        stateDir: directory,
        bootId: Effect.succeed("boot-one"),
        processTable: processTable([{ pid: 1234, pgid: 1234, argv: `codex ${socketPath}` }]),
        socketAccepts: () => Effect.succeed(false),
        signalGroup: (_pgid: number, signal: string) =>
          Effect.sync(() => {
            signals.push(signal);
          }),
      });
      const closing = yield* service.close(record).pipe(Effect.forkScoped);
      yield* TestClock.adjust("5 seconds");
      yield* TestClock.adjust("5 seconds");
      assert.equal((yield* Fiber.join(closing)).outcome, "blocked");
      assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
    }),
  ),
);

const openService = (
  directory: string,
  options: {
    readonly socketDirectory?: string;
    readonly exitCode?: number;
    readonly stderr?: string;
    readonly stderrPaths?: string[];
    readonly members?: ReadonlyArray<{ pid: number; pgid: number; argv: string }>;
    readonly signals?: string[];
  },
) =>
  makeDetachedAppServers({
    stateDir: directory,
    bootId: Effect.succeed("boot-one"),
    processTable: processTable(options.members ?? []),
    socketAccepts: () => Effect.succeed(false),
    signalGroup: (_pgid: number, signal: string) =>
      Effect.sync(() => {
        options.signals?.push(signal);
      }),
    socketDirectory: Effect.succeed(options.socketDirectory ?? "/tmp/goat-test/codex"),
    launch: (input) =>
      Effect.promise(async () => {
        options.stderrPaths?.push(input.stderrPath);
        if (options.stderr !== undefined) await NodeFSP.writeFile(input.stderrPath, options.stderr);
        return {
          pid: 4321,
          exited: options.exitCode === undefined ? Effect.never : Effect.succeed(options.exitCode),
        };
      }),
    connect: () =>
      options.exitCode === undefined
        ? Effect.succeed({
            incoming: Stream.never,
            send: () => Effect.void,
            closed: Effect.never,
          })
        : Effect.fail(new CodexDetachedAppServerError({ detail: "not listening" })),
  });

const openInput = {
  instanceId: "codex",
  command: (socket: string) =>
    Effect.succeed({ command: "codex", args: ["app-server", "--listen", "unix://" + socket] }),
};

it.effect(
  "open fails with Codex's last stderr line when it exits before accepting connections",
  () =>
    withRecordDirectory((directory) =>
      Effect.gen(function* () {
        const service = yield* openService(directory, {
          exitCode: 2,
          stderr: "starting\nerror: unknown config key\n",
        });
        const error = yield* service.open(openInput).pipe(Effect.scoped, Effect.flip);
        assert.include(error.message, "error: unknown config key");
        assert.deepEqual(
          yield* Effect.promise(() =>
            NodeFSP.readdir(NodePath.join(directory, "codex-app-servers")),
          ),
          [],
        );
      }),
    ),
);

it.effect("open refuses a socket path Codex cannot bind", () =>
  withRecordDirectory((directory) =>
    Effect.gen(function* () {
      const service = yield* openService(directory, { socketDirectory: "/tmp/" + "x".repeat(100) });
      const error = yield* service.open(openInput).pipe(Effect.scoped, Effect.flip);
      assert.include(error.message, "103 bytes");
    }),
  ),
);

it.effect(
  "an opened app-server is recorded with its group and terminated when its scope closes",
  () =>
    withRecordDirectory((directory) =>
      Effect.gen(function* () {
        const signals: string[] = [];
        let recordedSocket = "";
        const service = yield* makeDetachedAppServers({
          stateDir: directory,
          bootId: Effect.succeed("boot-one"),
          processTable: {
            groupMembers: () =>
              Effect.sync(() =>
                signals.length === 0
                  ? [{ pid: 4321, pgid: 4321, argv: "codex " + recordedSocket }]
                  : [],
              ),
            ownerOfSocket: () => Effect.void.pipe(Effect.as(undefined)),
          },
          socketAccepts: () => Effect.succeed(false),
          signalGroup: (_pgid: number, signal: string) =>
            Effect.sync(() => {
              signals.push(signal);
            }),
          socketDirectory: Effect.succeed("/tmp/goat-test/codex"),
          launch: () => Effect.succeed({ pid: 4321, exited: Effect.never }),
          connect: () =>
            Effect.succeed({
              incoming: Stream.never,
              send: () => Effect.void,
              closed: Effect.never,
            }),
        });
        yield* Effect.gen(function* () {
          const opened = yield* service.open(openInput);
          recordedSocket = opened.record.socketPath;
          assert.equal(opened.record.pgid, 4321);
          assert.equal(opened.record.state, "running");
        }).pipe(Effect.scoped);
        assert.deepEqual(signals, ["SIGTERM"]);
        assert.deepEqual(
          yield* Effect.promise(() =>
            NodeFSP.readdir(NodePath.join(directory, "codex-app-servers")),
          ),
          [],
        );
      }),
    ),
);

it.effect("a socket directory other users can write to is refused", () =>
  withRecordDirectory((directory) =>
    Effect.gen(function* () {
      const root = NodePath.join(directory, "shared");
      yield* Effect.promise(() => NodeFSP.mkdir(root, { mode: 0o777 }));
      yield* Effect.promise(() => NodeFSP.chmod(root, 0o777));
      const error = yield* privateSocketDirectory(root, NodeOS.userInfo().uid).pipe(Effect.flip);
      assert.include(error.message, "not private");
      const safe = NodePath.join(directory, "private");
      assert.equal(
        yield* privateSocketDirectory(safe, NodeOS.userInfo().uid),
        NodePath.join(safe, "codex"),
      );
    }),
  ),
);

it.effect("cleanup removes GOAT's socket alias once the recorded group is gone", () =>
  withRecordDirectory((directory) =>
    Effect.gen(function* () {
      const dir = NodePath.join(directory, "codex-app-servers");
      const alias = NodePath.join(directory, "alias.sock");
      yield* Effect.promise(() => NodeFSP.mkdir(dir));
      yield* Effect.promise(() => NodeFSP.writeFile(alias, ""));
      const aliased = { ...record, socketPath: alias };
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(dir, aliased.name + ".json"), JSON.stringify(aliased)),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(dir, aliased.name + ".pid"), "1234"),
      );
      const service = yield* makeDetachedAppServers({
        stateDir: directory,
        bootId: Effect.succeed("boot-one"),
        processTable: processTable([]),
        socketAccepts: () => Effect.succeed(false),
        signalGroup: () => Effect.die("unexpected signal"),
      });
      const outcomes = yield* service.cleanup;
      assert.equal(outcomes[0]?.outcome, "cleaned");
      assert.isFalse(
        yield* Effect.promise(() =>
          NodeFSP.access(alias).then(
            () => true,
            () => false,
          ),
        ),
      );
    }),
  ),
);

it.effect("the group is re-verified before SIGKILL and an unprovable group is not killed", () =>
  withRecordDirectory((directory) =>
    Effect.gen(function* () {
      const signals: string[] = [];
      const service = yield* makeDetachedAppServers({
        stateDir: directory,
        bootId: Effect.succeed("boot-one"),
        processTable: {
          groupMembers: () =>
            signals.length === 0
              ? Effect.succeed([{ pid: 1234, pgid: 1234, argv: "codex " + socketPath }])
              : Effect.fail(new CodexDetachedAppServerError({ detail: "ps unavailable" })),
          ownerOfSocket: () => Effect.void.pipe(Effect.as(undefined)),
        },
        socketAccepts: () => Effect.succeed(false),
        signalGroup: (_pgid: number, signal: string) =>
          Effect.sync(() => {
            signals.push(signal);
          }),
      });
      const closing = yield* service.close(record).pipe(Effect.forkScoped);
      yield* TestClock.adjust("5 seconds");
      assert.equal((yield* Fiber.join(closing)).outcome, "blocked");
      assert.deepEqual(signals, ["SIGTERM"]);
    }),
  ),
);

it.effect("an unreadable record blocks every Codex provider until it is resolved", () =>
  withRecordDirectory((directory) =>
    Effect.gen(function* () {
      const dir = NodePath.join(directory, "codex-app-servers");
      yield* Effect.promise(() => NodeFSP.mkdir(dir));
      const broken = NodePath.join(dir, "unknown-instance.json");
      yield* Effect.promise(() => NodeFSP.writeFile(broken, "{not json"));
      const service = yield* makeDetachedAppServers({
        stateDir: directory,
        bootId: Effect.succeed("boot-one"),
        processTable: processTable([]),
        socketAccepts: () => Effect.succeed(false),
        signalGroup: () => Effect.die("unexpected signal"),
      });
      assert.equal((yield* service.cleanup)[0]?.outcome, "blocked");
      const error = yield* service.ensureNotBlocked("any-provider").pipe(Effect.flip);
      assert.include(error.message, "unreadable");
      yield* Effect.promise(() => NodeFSP.rm(broken));
      yield* service.ensureNotBlocked("any-provider");
    }),
  ),
);

it.effect("invalid record shapes block every provider", () =>
  withRecordDirectory((directory) =>
    Effect.gen(function* () {
      const dir = NodePath.join(directory, "codex-app-servers");
      yield* Effect.promise(() => NodeFSP.mkdir(dir));
      const path = NodePath.join(dir, record.name + ".json");
      const service = yield* makeDetachedAppServers({
        stateDir: directory,
        bootId: Effect.succeed("boot-one"),
        processTable: processTable([]),
        socketAccepts: () => Effect.succeed(false),
        signalGroup: () => Effect.void,
      });
      for (const value of [null, { ...record, instanceId: undefined }]) {
        yield* Effect.promise(() => NodeFSP.writeFile(path, JSON.stringify(value)));
        assert.equal((yield* service.cleanup)[0]?.outcome, "blocked");
        for (const provider of ["first", "second"]) {
          const error = yield* service.ensureNotBlocked(provider).pipe(Effect.flip);
          assert.include(error.message, "unreadable");
        }
      }
    }),
  ),
);

it.effect("a cleanup defect leaves all providers blocked", () =>
  withRecordDirectory((directory) =>
    Effect.gen(function* () {
      const dir = NodePath.join(directory, "codex-app-servers");
      yield* Effect.promise(() => NodeFSP.mkdir(dir));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(dir, record.name + ".json"), JSON.stringify(record)),
      );
      const service = yield* makeDetachedAppServers({
        stateDir: directory,
        bootId: Effect.die("unexpected"),
        processTable: processTable([]),
        socketAccepts: () => Effect.succeed(false),
        signalGroup: () => Effect.void,
      });
      yield* service.cleanup.pipe(Effect.exit);
      for (const provider of ["first", "second"]) {
        const error = yield* service.ensureNotBlocked(provider).pipe(Effect.flip);
        assert.include(error.message, "cleanup did not complete");
      }
    }),
  ),
);

it.effect("a command construction failure removes its spawning record", () =>
  withRecordDirectory((directory) =>
    Effect.gen(function* () {
      const service = yield* openService(directory, {});
      yield* service
        .open({
          ...openInput,
          command: () => Effect.fail(new CodexDetachedAppServerError({ detail: "failed" })),
        })
        .pipe(Effect.scoped, Effect.exit);
      assert.deepEqual(
        yield* Effect.promise(() => NodeFSP.readdir(NodePath.join(directory, "codex-app-servers"))),
        [],
      );
    }),
  ),
);

it.effect("scoped stderr maintenance truncates oversized logs and preserves small logs", () =>
  withRecordDirectory((directory) =>
    Effect.gen(function* () {
      const stderrPaths: string[] = [];
      const service = yield* openService(directory, { stderrPaths });
      yield* service.open(openInput);
      yield* service.open(openInput);
      const [large, small] = stderrPaths;
      assert.isDefined(large);
      assert.isDefined(small);
      if (large === undefined || small === undefined) return;
      yield* Effect.promise(() => NodeFSP.writeFile(large, Buffer.alloc(4 * 1024 * 1024 + 1)));
      yield* Effect.promise(() => NodeFSP.writeFile(small, "keep this"));
      yield* TestClock.adjust("30 seconds");
      assert.equal((yield* Effect.promise(() => NodeFSP.stat(large))).size, 0);
      assert.equal(yield* Effect.promise(() => NodeFSP.readFile(small, "utf8")), "keep this");
    }),
  ),
);
