// @effect-diagnostics nodeBuiltinImport:off -- fixtures use an isolated temporary record directory.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, RunId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { makeDetachedAppServers } from "./CodexDetachedAppServer.ts";
import * as Detached from "./CodexDetachedAppServerLive.ts";
import * as Survivors from "./CodexSurvivors.ts";

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

const openService = (directory: string, _options: {}) =>
  makeDetachedAppServers({
    stateDir: directory,
    bootId: Effect.succeed("boot-one"),
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
const openInput = {
  instanceId: "codex",
  command: (socket: string) =>
    Effect.succeed({ command: "codex", args: ["app-server", "--listen", "unix://" + socket] }),
};

it.effect("concurrent stop and goal fences are durable and gate admission", () =>
  withRecordDirectory((directory) =>
    Effect.gen(function* () {
      const service = yield* openService(directory, {});
      const opened = yield* service.open(openInput);
      const key = { instanceId: ProviderInstanceId.make("codex"), recordName: opened.record.name };
      const threadId = ThreadId.make("thread-fenced");
      const stop = { threadId, nativeThreadId: "native-thread", nativeTurnId: "native-turn" };
      const goal = { threadId, nativeThreadId: "native-thread" };
      yield* Effect.all(
        [service.recordStopObligation(key, stop), service.recordGoalBlock(key, goal)],
        { concurrency: "unbounded" },
      );
      const contents = yield* Effect.promise(() =>
        NodeFSP.readFile(
          NodePath.join(directory, "codex-app-servers", key.recordName + ".json"),
          "utf8",
        ),
      );
      const saved = JSON.parse(contents);
      assert.deepEqual(saved.stopObligations, [stop]);
      assert.deepEqual(saved.goalBlocks, [goal]);
      assert.deepEqual(yield* service.getGoalBlocks(threadId), [{ record: key, block: goal }]);
      assert.deepEqual(yield* service.getStopObligations(threadId), [{ record: key, block: stop }]);
      const stopped = yield* service
        .ensureAdmission(threadId, { allowGoalControl: true })
        .pipe(Effect.flip);
      assert.equal(stopped.detail, "Codex is running work on this thread from before the restart.");
      assert.equal((yield* service.ensureAdmission(threadId).pipe(Effect.exit))._tag, "Failure");
      yield* service.clearStopObligation(key, stop);
      const goalError = yield* service.ensureAdmission(threadId).pipe(Effect.flip);
      assert.equal(
        goalError.detail,
        "Codex is still running a goal on this thread from before the restart. Send /goal pause or /goal clear to continue here.",
      );
      yield* service.ensureAdmission(threadId, { allowGoalControl: true });
      yield* service.clearGoalBlock(key, goal);
      yield* service.ensureAdmission(threadId);
    }),
  ),
);

it.effect("a failed stop-fence write keeps admission blocked despite other record updates", () =>
  withRecordDirectory((directory) =>
    Effect.gen(function* () {
      const service = yield* openService(directory, {});
      const opened = yield* service.open(openInput);
      const key = { instanceId: ProviderInstanceId.make("codex"), recordName: opened.record.name };
      const threadId = ThreadId.make("thread-failed-fence");
      const stop = { threadId, nativeThreadId: "native-thread", nativeTurnId: "native-turn" };
      yield* service
        .recordStopObligation({ ...key, recordName: "missing" }, stop)
        .pipe(Effect.flip);
      yield* service.recordGoalBlock(key, { threadId, nativeThreadId: "native-thread" });
      yield* service.clearGoalBlock(key, { threadId, nativeThreadId: "native-thread" });
      assert.equal((yield* service.ensureAdmission(threadId).pipe(Effect.exit))._tag, "Failure");
      assert.equal(
        (yield* service.ensureAdmission(threadId, { allowGoalControl: true }).pipe(Effect.exit))
          ._tag,
        "Failure",
      );
    }),
  ),
);

it.effect("removing an unreadable record lets the next admission through without a restart", () =>
  withRecordDirectory((directory) =>
    Effect.gen(function* () {
      const records = NodePath.join(directory, "codex-app-servers");
      yield* Effect.promise(() => NodeFSP.mkdir(records, { recursive: true }));
      const broken = NodePath.join(records, "broken.json");
      yield* Effect.promise(() => NodeFSP.writeFile(broken, "null"));
      const service = yield* openService(directory, {});
      yield* service.cleanup;
      const threadId = ThreadId.make("thread-after-repair");
      assert.equal((yield* service.ensureAdmission(threadId).pipe(Effect.exit))._tag, "Failure");
      yield* Effect.promise(() => NodeFSP.rm(broken));
      yield* service.ensureAdmission(threadId);
    }),
  ),
);

it.effect("the global-block retry never signals an app-server this server run owns", () =>
  withRecordDirectory((directory) =>
    Effect.gen(function* () {
      const signals: string[] = [];
      const service = yield* makeDetachedAppServers({
        stateDir: directory,
        bootId: Effect.succeed("boot-one"),
        processTable: {
          groupMembers: () => Effect.succeed([]),
          ownerOfSocket: () => Effect.void.pipe(Effect.as(undefined)),
        },
        socketAccepts: () => Effect.succeed(false),
        signalGroup: (_pgid, signal) => Effect.sync(() => void signals.push(signal)),
        socketDirectory: Effect.succeed("/tmp/goat-test/codex"),
        launch: (input) =>
          Effect.promise(() => NodeFSP.writeFile(input.pidFile, "4321")).pipe(
            Effect.as({
              pid: 4321,
              exited: Effect.never,
              signalIfAlive: (signal: "SIGTERM" | "SIGKILL") => {
                signals.push(signal);
                return true;
              },
            }),
          ),
        connect: () =>
          Effect.succeed({ incoming: Stream.never, send: () => Effect.void, closed: Effect.never }),
      });
      const opened = yield* service.open(openInput);
      const records = NodePath.join(directory, "codex-app-servers");
      const broken = NodePath.join(records, "broken.json");
      yield* Effect.promise(() => NodeFSP.writeFile(broken, "null"));
      assert.isDefined((yield* service.loadRecords).globalBlock);
      const threadId = ThreadId.make("thread-beside-owned");
      assert.equal((yield* service.ensureAdmission(threadId).pipe(Effect.exit))._tag, "Failure");
      assert.deepEqual(signals, []);
      yield* Effect.promise(() =>
        NodeFSP.access(NodePath.join(records, opened.record.name + ".json")),
      );
      yield* Effect.promise(() => NodeFSP.rm(broken));
      yield* service.ensureAdmission(threadId);
      assert.deepEqual(signals, []);
      yield* Effect.promise(() =>
        NodeFSP.access(NodePath.join(records, opened.record.name + ".json")),
      );
    }),
  ),
);

it.effect("an unreadable record refuses only turns that would use the socket or are fenced", () =>
  withRecordDirectory((directory) =>
    Effect.gen(function* () {
      const records = NodePath.join(directory, "codex-app-servers");
      yield* Effect.promise(() => NodeFSP.mkdir(records, { recursive: true }));
      yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(records, "broken.json"), "null"));
      const service = yield* openService(directory, {});
      yield* service.cleanup;
      const fenced = ThreadId.make("thread-fenced");
      yield* service
        .recordStopObligation(
          { instanceId: ProviderInstanceId.make("codex"), recordName: "missing" },
          { threadId: fenced, nativeThreadId: "native-thread", nativeTurnId: "native-turn" },
        )
        .pipe(Effect.flip);
      const bound = ThreadId.make("thread-bound");
      const free = ThreadId.make("thread-free");
      const admits = (
        mode: "auto" | "unsupported",
        threadId: ThreadId,
        survival?: "off" | "restart" | "always",
      ) =>
        Effect.gen(function* () {
          const survivors = yield* Survivors.CodexSurvivors;
          yield* survivors.replace([
            {
              instanceId: ProviderInstanceId.make("codex"),
              recordName: "codex-bound",
              threadId: bound,
              sourceRunId: RunId.make("run-bound"),
              nativeThreadId: "native-bound",
              nativeTurnId: "native-turn-bound",
            },
          ]);
          const exit = yield* survivors
            .ensureAdmission(threadId, survival === undefined ? undefined : { survival })
            .pipe(Effect.exit);
          return exit._tag === "Success";
        }).pipe(
          Effect.provide(
            Survivors.layer.pipe(
              Layer.provide(
                Layer.succeed(Detached.CodexDetachedAppServers, {
                  ...service,
                  socketTransportEnabled: false,
                  socketTransportMode: mode,
                }),
              ),
            ),
          ),
        );
      assert.isTrue(yield* admits("auto", free, "off"));
      assert.isTrue(yield* admits("unsupported", free, "always"));
      assert.isFalse(yield* admits("auto", free, "restart"));
      assert.isFalse(yield* admits("auto", free));
      assert.isFalse(yield* admits("auto", fenced, "off"));
      assert.isFalse(yield* admits("auto", bound, "off"));
    }),
  ),
);
