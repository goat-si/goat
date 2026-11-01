// @effect-diagnostics nodeBuiltinImport:off - hashes a goal id into a folder name and moves bundle bytes.
/**
 * Local recovery for goal attempts (docs/internals/agentic-k8s.md "Resume from the branch or a
 * replica"). After each finished turn of an attempt on this machine, its worktree is captured as a
 * replica into fleet_replicas. A later attempt of the same slot starts on this machine from the
 * newest replica that imports with its recorded commit, else the newest attempt branch, else the
 * goal's base, and only once the attempt before it has stopped. Remote attempts still move through
 * Rescheduler, which refuses replica resumes until remote goal workers return (#576).
 */
import * as NodeBuffer from "node:buffer";
import * as NodeCrypto from "node:crypto";

import type { FleetGoal, FleetGoalId, RunId, ThreadId } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import {
  applyReplicaScript,
  captureReplicaScript,
  DEFAULT_MAX_BUNDLE_BYTES,
  DEFAULT_MAX_UNTRACKED_FILE_BYTES,
  parseApplyOutput,
  parseReplicaOutput,
  replicaRefFor,
  resumeBranchFor,
} from "../../channels/channelReplica.ts";
import * as ServerConfig from "../../config.ts";
import { ProjectStoreV2 } from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../../processRunner.ts";
import { isStopped, localStatusOf } from "../health/Health.ts";
import { branchFor, launchActionId, ORPHAN_SLOT_BASE } from "./goalPlan.ts";
import type { WorkerRecord } from "./GoalStore.ts";
import { type WorkerReading, workerThreadId } from "./GoalWorkerRuntime.ts";

/** Where a later attempt starts, or why it cannot start yet. */
export type Resume =
  | {
      readonly _tag: "Start";
      /** Null: the goal's own workspace, as for a first attempt. */
      readonly workspace: { readonly baseRef: string; readonly startFromOrigin: boolean } | null;
      /** Appended to the prompt when the attempt picks up earlier work. */
      readonly note: string | null;
    }
  /** The attempt before it is active or unreadable; asked again on the next pass. */
  | { readonly _tag: "Wait"; readonly message: string }
  /** A replica exists but does not import with its recorded commit; nothing may launch from it. */
  | { readonly _tag: "Refused"; readonly message: string };

export class GoalRecovery extends Context.Service<
  GoalRecovery,
  {
    /** Captures a finished turn of an attempt on this machine, once per run; never fails the pass. */
    readonly capture: (
      goal: FleetGoal,
      worker: WorkerRecord,
      reading: WorkerReading,
    ) => Effect.Effect<void>;
    /** Where a slot's attempt starts on this machine; a first attempt uses the goal's workspace. */
    readonly resume: (goal: FleetGoal, slot: number, attempt: number) => Effect.Effect<Resume>;
    /** Drops a deleted goal's replica rows and bundles. */
    readonly forget: (goalId: FleetGoalId) => Effect.Effect<void>;
  }
>()("goat/fleet/goals/GoalRecovery") {}

class RecoveryFailure extends Data.TaggedError("RecoveryFailure")<{ readonly message: string }> {}

const REPLICA_MESSAGE = "GOAT goal replica: changes not committed yet";
const START: Resume = { _tag: "Start", workspace: null, note: null };

const ownerKeyOf = (goalId: string, slot: number) => "goal:" + goalId + ":s" + slot;
const taskOf = (goalId: string, slot: number) => "goal-" + goalId + "-s" + slot;
const folderOf = (goalId: string) =>
  NodeCrypto.createHash("sha256").update(goalId).digest("hex").slice(0, 32);
const clip = (text: string) => Array.from(text.trim()).slice(-300).join("");

const resumeNote = (attempt: number, source: string) =>
  [
    "GOAT restarted this work on this machine after attempt " + attempt + " stopped.",
    "You are on a new branch started from " + source + ".",
    "Check git log and git status first.",
  ].join("\n");

interface ReplicaRow {
  readonly generation: number;
  readonly ref: string;
  readonly file: string;
  readonly commit_oid: string;
}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectStoreV2;
  const runner = yield* ProcessRunner.ProcessRunner;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const root = path.join(config.stateDir, "fleet-replicas");
  // The run each attempt was last captured at. A restart captures a stopped attempt once more,
  // which is harmless: the replica commit has fixed metadata, so an unchanged tree repeats it.
  const captured = new Map<string, RunId>();

  const run = (command: "sh" | "git", args: ReadonlyArray<string>, cwd?: string, stdin?: string) =>
    runner
      .run({
        command,
        args,
        cwd,
        stdin,
        timeout: "120 seconds",
        maxOutputBytes: DEFAULT_MAX_BUNDLE_BYTES * 2,
        env: {
          ...process.env,
          GIT_DIR: undefined,
          GIT_WORK_TREE: undefined,
          GIT_COMMON_DIR: undefined,
          GIT_INDEX_FILE: undefined,
          GIT_OBJECT_DIRECTORY: undefined,
          GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
          GIT_TERMINAL_PROMPT: "0",
        },
      })
      .pipe(Effect.mapError(() => new RecoveryFailure({ message: command + " could not run" })));

  const sh = (script: string) =>
    run("sh", ["-s"], undefined, script).pipe(
      Effect.flatMap((result) =>
        result.code === 0 && !result.timedOut
          ? Effect.succeed(result.stdout)
          : Effect.fail(new RecoveryFailure({ message: "git failed: " + clip(result.stderr) })),
      ),
    );

  const revParse = (cwd: string, ref: string) =>
    run("git", ["rev-parse", "--verify", "--quiet", ref + "^{commit}"], cwd).pipe(
      Effect.map((result) => (result.code === 0 ? result.stdout.trim() : null)),
    );

  const isAncestor = (cwd: string, ancestor: string, descendant: string) =>
    run("git", ["merge-base", "--is-ancestor", ancestor, descendant], cwd).pipe(
      Effect.flatMap((result) =>
        result.code === 0 || result.code === 1
          ? Effect.succeed(result.code === 0)
          : Effect.fail(new RecoveryFailure({ message: "git merge-base failed" })),
      ),
    );

  /** A local attempt read from its shell: stopped (with its latest run), gone, or not yet movable. */
  const readAttempt = Effect.fn("GoalRecovery.readAttempt")(function* (threadId: ThreadId) {
    const read = yield* threads.getThreadShell(threadId).pipe(Effect.result);
    if (read._tag === "Failure")
      return {
        _tag: "Wait",
        message: "The previous attempt could not be read; it is asked again on the next pass.",
      } as const;
    const shell = read.success;
    if (shell === null || shell.deletedAt !== null) return { _tag: "Gone" } as const;
    const status = localStatusOf(shell);
    if (!isStopped(status))
      return {
        _tag: "Wait",
        message:
          "The previous attempt is still active on this machine; it restarts once that stops.",
      } as const;
    return {
      _tag: "Stopped",
      runId: status.run?.runId ?? null,
      worktreePath: shell.worktreePath,
    } as const;
  });

  const captureRun = Effect.fn("GoalRecovery.captureRun")(function* (
    goal: FleetGoal,
    slot: number,
    attempt: number,
    threadId: ThreadId,
    runId: RunId,
  ) {
    const key = goal.id + "\n" + slot + "\n" + attempt;
    if (captured.get(key) === runId) return;
    const before = yield* readAttempt(threadId);
    if (before._tag !== "Stopped" || before.runId !== runId) return;
    // Nothing to read: a worker without a worktree, or one whose worktree was removed.
    if (before.worktreePath === null || !(yield* fs.exists(before.worktreePath))) {
      captured.set(key, runId);
      return;
    }
    const parsed = parseReplicaOutput(
      yield* sh(
        captureReplicaScript({
          cwd: before.worktreePath,
          replicaRef: replicaRefFor(taskOf(goal.id, slot), attempt),
          maxBundleBytes: DEFAULT_MAX_BUNDLE_BYTES,
          maxUntrackedFileBytes: DEFAULT_MAX_UNTRACKED_FILE_BYTES,
          message: REPLICA_MESSAGE,
        }),
      ),
    );
    if (parsed.type !== "ok") {
      captured.set(key, runId);
      return yield* Effect.logInfo("fleet.goal.replica_skipped", {
        goalId: goal.id,
        slot,
        attempt,
        reason: parsed.type,
      });
    }
    // A turn that ran while the tree was read would leave a snapshot of no finished turn.
    const after = yield* readAttempt(threadId);
    if (after._tag !== "Stopped" || after.runId !== runId) return;
    const folder = path.join(root, folderOf(goal.id));
    // Named by commit, so a crash between the write and the row never changes a recorded bundle.
    const file = path.join(
      folder,
      "s" + slot + "-a" + attempt + "-" + parsed.commitOid + ".bundle",
    );
    yield* fs.makeDirectory(folder, { recursive: true, mode: 0o700 });
    yield* fs.writeFile(file + ".partial", NodeBuffer.Buffer.from(parsed.bundleBase64, "base64"));
    yield* fs.rename(file + ".partial", file);
    const owner = ownerKeyOf(goal.id, slot);
    const capturedAt = DateTime.formatIso(yield* DateTime.now);
    const previous = yield* sql<{ readonly file: string }>`
      SELECT file FROM fleet_replicas WHERE owner_key = ${owner} AND generation = ${attempt}
    `;
    yield* sql`
      INSERT INTO fleet_replicas (owner_key, generation, ref, file, commit_oid, captured_at)
      VALUES (${owner}, ${attempt}, ${replicaRefFor(taskOf(goal.id, slot), attempt)}, ${file}, ${parsed.commitOid}, ${capturedAt})
      ON CONFLICT (owner_key, generation) DO UPDATE SET
        ref = excluded.ref,
        file = excluded.file,
        commit_oid = excluded.commit_oid,
        captured_at = excluded.captured_at
    `;
    const stale = previous[0]?.file;
    if (stale !== undefined && stale !== file) yield* fs.remove(stale).pipe(Effect.ignore);
    // Only a published replica counts; a failure above leaves the run to be captured again.
    captured.set(key, runId);
    if (parsed.excluded.length > 0)
      yield* Effect.logInfo("fleet.goal.replica_excluded_files", {
        goalId: goal.id,
        slot,
        attempt,
        count: parsed.excluded.length,
      });
  });

  const logCaptureFailure = (goal: FleetGoal, slot: number) => (error: unknown) =>
    Effect.logWarning("fleet.goal.replica_capture_failed", { goalId: goal.id, slot, error });

  /** Imports the bundle into a branch named by its commit; fails unless that commit arrives. */
  const importReplica = Effect.fn("GoalRecovery.importReplica")(function* (
    cwd: string,
    goal: FleetGoal,
    slot: number,
    row: ReplicaRow,
  ) {
    const bytes = yield* fs
      .readFile(row.file)
      .pipe(Effect.mapError(() => new RecoveryFailure({ message: "its bundle is missing" })));
    const branch = resumeBranchFor(
      taskOf(goal.id, slot) + "-" + row.commit_oid.slice(0, 12),
      row.generation,
    );
    const script = yield* Effect.try({
      try: () =>
        applyReplicaScript({
          cwd,
          bundleBase64: NodeBuffer.Buffer.from(bytes).toString("base64"),
          replicaRef: row.ref,
          targetRef: "refs/heads/" + branch,
          fetchRemotes: false,
          expectedCommitOid: row.commit_oid,
        }),
      catch: () => new RecoveryFailure({ message: "its bundle is empty" }),
    });
    const applied = parseApplyOutput(yield* sh(script));
    if (applied.type === "applied" && applied.oid === row.commit_oid) return branch;
    return yield* new RecoveryFailure({
      message:
        applied.type === "base_missing"
          ? "the bundle is unreadable or its base commits are missing"
          : applied.type === "ref_conflict"
            ? "its resume branch points elsewhere"
            : "the bundle does not hold commit " + row.commit_oid.slice(0, 12),
    });
  });

  const pickStart = Effect.fn("GoalRecovery.pickStart")(function* (
    goal: FleetGoal,
    slot: number,
    attempt: number,
  ) {
    const projectId = goal.spec.project.projectId;
    // The launch itself reports a missing project.
    if (projectId === null) return START;
    const project = yield* projects.get(projectId);
    if (Option.isNone(project)) return START;
    const cwd = project.value.workspaceRoot;
    const owner = ownerKeyOf(goal.id, slot);
    // Every earlier attempt counts: one that never started leaves its predecessor's replica.
    const [row] = yield* sql<ReplicaRow>`
      SELECT generation, ref, file, commit_oid FROM fleet_replicas
      WHERE owner_key = ${owner} AND generation < ${attempt}
      ORDER BY generation DESC LIMIT 1
    `;
    let branch: { readonly name: string; readonly tip: string } | null = null;
    for (let earlier = attempt - 1; earlier >= 1 && branch === null; earlier -= 1) {
      const name = branchFor(goal, slot, earlier);
      const tip = yield* revParse(cwd, "refs/heads/" + name);
      if (tip !== null) branch = { name, tip };
    }
    if (row !== undefined) {
      const imported = yield* importReplica(cwd, goal, slot, row).pipe(Effect.result);
      if (imported._tag === "Failure")
        return {
          _tag: "Refused",
          message:
            "The replica of attempt " +
            row.generation +
            " could not be verified (" +
            imported.failure.message +
            "); nothing was launched. It is checked again on the next pass.",
        } satisfies Resume;
      // By commit, not by kind: whichever contains the other; neither, the replica, which also
      // holds the changes that were never committed.
      const fromReplica =
        branch === null ||
        (yield* isAncestor(cwd, branch.tip, row.commit_oid)) ||
        !(yield* isAncestor(cwd, row.commit_oid, branch.tip));
      if (fromReplica)
        return {
          _tag: "Start",
          workspace: { baseRef: imported.success, startFromOrigin: false },
          note: resumeNote(
            attempt - 1,
            "a replica of attempt " +
              row.generation +
              "'s last finished turn; its newest commit holds the changes it had not committed",
          ),
        } satisfies Resume;
    }
    if (branch === null) return START;
    return {
      _tag: "Start",
      workspace: { baseRef: branch.name, startFromOrigin: false },
      note: resumeNote(attempt - 1, "branch " + branch.name),
    } satisfies Resume;
  });

  const resume = Effect.fn("GoalRecovery.resume")(function* (
    goal: FleetGoal,
    slot: number,
    attempt: number,
  ) {
    if (attempt <= 1) return START;
    // Every earlier attempt of the slot, newest first: one that never started does not hide an
    // older one that runs again. Local attempts get their thread id from their launch id.
    const earlier = Array.from({ length: attempt - 1 }, (_, index) => ({
      attempt: attempt - 1 - index,
      threadId: workerThreadId(launchActionId(goal, slot, attempt - 1 - index)),
    }));
    const readAll = Effect.forEach(earlier, (entry) => readAttempt(entry.threadId));
    const before = yield* readAll;
    for (const entry of before) if (entry._tag === "Wait") return entry satisfies Resume;
    // The newest attempt that ran is the one whose work continues.
    const newest = before.findIndex((entry) => entry._tag === "Stopped");
    const last = before[newest];
    const lastEntry = earlier[newest];
    if (last?._tag === "Stopped" && last.runId !== null && lastEntry !== undefined) {
      const capture = yield* captureRun(
        goal,
        slot,
        lastEntry.attempt,
        lastEntry.threadId,
        last.runId,
      ).pipe(Effect.result);
      if (capture._tag === "Failure") {
        yield* logCaptureFailure(goal, slot)(capture.failure);
        return {
          _tag: "Wait",
          message: "The previous attempt's last turn could not be captured; it is tried again.",
        } satisfies Resume;
      }
    }
    const start = yield* pickStart(goal, slot, attempt).pipe(
      Effect.catch((error) =>
        Effect.succeed<Resume>({
          _tag: "Wait",
          message: "Could not read the previous attempt's work: " + error.message,
        }),
      ),
    );
    // Their work was read and imported as it was then; none may have run or started since.
    if (start._tag !== "Start") return start;
    const after = yield* readAll;
    const unchanged = after.every((entry, index) => {
      const was = before[index];
      return entry._tag === "Stopped"
        ? was?._tag === "Stopped" && entry.runId === was.runId
        : entry._tag === was?._tag;
    });
    if (!unchanged)
      return {
        _tag: "Wait",
        message: "The previous attempt ran again while it was being recovered; it is asked again.",
      } satisfies Resume;
    return start;
  });

  return GoalRecovery.of({
    capture: (goal, worker, reading) =>
      worker.host !== null ||
      worker.threadId === null ||
      // An orphan keeps its old attempt under a new slot number; resume captures it by its own.
      worker.slot >= ORPHAN_SLOT_BASE ||
      reading.kind !== "seen" ||
      !reading.terminal ||
      reading.runId === null
        ? Effect.void
        : captureRun(goal, worker.slot, worker.attempt, worker.threadId, reading.runId).pipe(
            Effect.catch(logCaptureFailure(goal, worker.slot)),
          ),
    resume,
    forget: Effect.fn("GoalRecovery.forget")(
      function* (goalId: FleetGoalId) {
        const prefix = "goal:" + goalId + ":s";
        yield* sql`
          DELETE FROM fleet_replicas WHERE substr(owner_key, 1, ${prefix.length}) = ${prefix}
        `;
        yield* fs.remove(path.join(root, folderOf(goalId)), { recursive: true, force: true });
        for (const key of captured.keys()) if (key.startsWith(goalId + "\n")) captured.delete(key);
      },
      (effect, goalId) =>
        effect.pipe(
          Effect.catch((error) =>
            Effect.logWarning("fleet.goal.replica_forget_failed", { goalId, error }),
          ),
        ),
    ),
  });
});

export const layer = Layer.effect(GoalRecovery, make);
