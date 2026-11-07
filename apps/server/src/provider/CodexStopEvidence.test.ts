// @effect-diagnostics nodeBuiltinImport:off -- record fixtures use isolated temporary directories.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { makeDetachedAppServers } from "./CodexDetachedAppServer.ts";
import * as Recovery from "./CodexSurvivorRecovery.ts";

it.effect(
  "a persisted waiter failure never clears a stop fence while the shared native turn is running",
  () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-stop-evidence-")),
        ),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const dir = NodePath.join(directory, "codex-app-servers");
      yield* Effect.promise(() => NodeFSP.mkdir(dir));
      const name = "codex-abcdefabcdef";
      const socket = "/tmp/goat-stop-evidence.sock";
      const threadId = ThreadId.make("thread-stopped");
      const block = { threadId, nativeThreadId: "native-thread", nativeTurnId: "native-turn" };
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
        stopObligations: [block],
      };
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(dir, name + ".json"), JSON.stringify(record)),
      );
      const detached = yield* makeDetachedAppServers({
        stateDir: directory,
        bootId: Effect.succeed("boot"),
        processTable: {
          groupMembers: () => Effect.succeed([{ pid: 4321, pgid: 4321, argv: socket }]),
          ownerOfSocket: () => Effect.void.pipe(Effect.as(undefined)),
        },
        socketAccepts: () => Effect.succeed(false),
        signalGroup: () => Effect.die("must not signal shared process"),
      });
      yield* detached.loadRecords;
      yield* detached.preserveForRecovery(name);
      const runId = RunId.make("run-adopted");
      const attemptId = RunAttemptId.make("attempt");
      const driver = ProviderDriverKind.make("codex");
      const turnId = IdAllocator.derive.providerTurn({
        driver,
        nativeTurnId: `native-turn:restart:${runId}`,
      });
      const providerThreadId = ProviderThreadId.make("provider-thread");
      const now = yield* DateTime.now;
      const run = {
        id: runId,
        threadId,
        status: "failed",
        activeAttemptId: attemptId,
        restartContinuationOfRunId: RunId.make("source"),
        providerThreadId,
      };
      const attempt = { id: attemptId, runId, status: "failed" };
      const turn = {
        id: turnId,
        runAttemptId: attemptId,
        status: "failed",
        nativeTurnRef: { driver, nativeId: "native-turn", strength: "strong" },
        completedAt: now,
      };
      const projections = {
        getRecoveryThreadIds: () => Effect.succeed([threadId]),
        getRuntimeRecoveryProjection: () =>
          Effect.succeed({
            runs: [run],
            providerThreads: [
              { id: providerThreadId, nativeThreadRef: { nativeId: "native-thread" } },
            ],
            nodes: [],
          }),
        getThreadRecords: () => Effect.succeed({ attempts: [attempt], providerTurns: [turn] }),
      };
      let nativeStatus: "running" | "interrupted" = "running";
      const survivors = {
        getStopObligations: detached.getStopObligations,
        clearStopObligation: detached.clearStopObligation,
        classifyRecord: detached.classifyRecord,
        readExistingTurn: () => Effect.sync(() => nativeStatus),
      };
      const outbox = {
        cancelContinuations: () => Effect.succeed([]),
        signalCancellations: () => Effect.void,
      };
      yield* Recovery.settleTerminalRuns({
        detached: { ...detached, socketTransportEnabled: true },
        projections: projections as never,
        survivors: survivors as never,
        outbox: outbox as never,
        sink: {} as never,
        ids: {} as never,
      });
      assert.equal((yield* detached.getStopObligations(threadId)).length, 1);
      assert.equal((yield* detached.ensureAdmission(threadId).pipe(Effect.exit))._tag, "Failure");
      assert.equal((yield* detached.cleanup)[0]?.outcome, "retained");
      nativeStatus = "interrupted";
      yield* Recovery.settleTerminalRuns({
        detached: { ...detached, socketTransportEnabled: true },
        projections: projections as never,
        survivors: survivors as never,
        outbox: outbox as never,
        sink: {} as never,
        ids: {} as never,
      });
      assert.equal((yield* detached.getStopObligations(threadId)).length, 0);
      assert.equal((yield* detached.ensureAdmission(threadId).pipe(Effect.exit))._tag, "Success");
    }).pipe(Effect.scoped),
);
