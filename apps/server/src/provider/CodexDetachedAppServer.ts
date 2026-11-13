// @effect-diagnostics nodeBuiltinImport:off -- ownership records need link(2) and O_EXCL semantics that FileSystem does not expose.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { type ProviderInstanceId, ProviderSessionId, ThreadId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import type { CodexAppServerMessageChannel } from "effect-codex-app-server/client";
import { blocksSession, recordKey, servesSession } from "./CodexRecordSessions.ts";
import { goalKey, sameGoal, sameStop, stopKey } from "./CodexFenceKeys.ts";
import { CodexDetachedAppServerError } from "./CodexDetachedAppServerError.ts";
import * as KeptRecord from "./CodexKeptRecord.ts";
import type {
  CodexGoalBlock,
  CodexInstanceRecordKey,
  CodexStopObligation,
} from "./CodexSurvivors.ts";

/**
 * Ownership of a Codex app-server that runs outside the GOAT server process. A signal is only ever
 * sent to a recorded process group that still carries the record's unique socket path in argv, or
 * to the verified owner of that socket; nothing is matched by name.
 */

export interface DetachedProcess {
  readonly pid: number;
  readonly pgid: number;
  readonly argv: string;
}

export interface DetachedAppServerRecord {
  readonly version: 1;
  readonly instanceId: string;
  readonly providerSessionId?: ProviderSessionId | undefined;
  readonly name: string;
  readonly socketPath: string;
  readonly pgid?: number | undefined;
  readonly bootId: string | null;
  readonly state: "spawning" | "running" | "terminating";
  readonly createdAt: string;
  readonly stderrMode?: "discard" | undefined;
  readonly stopObligations?: ReadonlyArray<CodexStopObligation> | undefined;
  readonly goalBlocks?: ReadonlyArray<CodexGoalBlock> | undefined;
}

const DetachedRecordSchema = Schema.Struct({
  version: Schema.Literal(1),
  instanceId: Schema.NonEmptyString,
  providerSessionId: Schema.optional(ProviderSessionId),
  name: Schema.NonEmptyString,
  socketPath: Schema.NonEmptyString,
  pgid: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  bootId: Schema.NullOr(Schema.String),
  state: Schema.Literals(["spawning", "running", "terminating"]),
  createdAt: Schema.String,
  stderrMode: Schema.optional(Schema.Literal("discard")),
  stopObligations: Schema.optional(
    Schema.Array(
      Schema.Struct({
        threadId: ThreadId,
        nativeThreadId: Schema.NonEmptyString,
        nativeTurnId: Schema.NonEmptyString,
      }),
    ),
  ),
  goalBlocks: Schema.optional(
    Schema.Array(Schema.Struct({ threadId: ThreadId, nativeThreadId: Schema.NonEmptyString })),
  ),
});
const decodeRecord = Schema.decodeUnknownSync(DetachedRecordSchema);

export interface DetachedProcessTable {
  readonly groupMembers: (
    pgid: number,
  ) => Effect.Effect<ReadonlyArray<DetachedProcess>, CodexDetachedAppServerError>;
  readonly ownerOfSocket: (
    socketPath: string,
  ) => Effect.Effect<DetachedProcess | undefined, CodexDetachedAppServerError>;
}

export type DetachedClassification =
  | {
      readonly type: "verified";
      readonly pgid: number;
      readonly members: ReadonlyArray<DetachedProcess>;
    }
  | { readonly type: "gone"; readonly possibleLeftovers?: ReadonlyArray<number> }
  | { readonly type: "mismatch" }
  | { readonly type: "unverifiable" };

export type DetachedOutcome = "cleaned" | "tombstoned" | "blocked" | "signalled" | "retained";

export { CodexDetachedAppServerError };
export { privateSocketDirectory } from "./CodexDetachedLaunch.ts";

const RECORD_DIRECTORY = "codex-app-servers";
const TERM_GRACE = "5 seconds";
const POLL = Schedule.spaced("250 millis");
const READINESS = Schedule.spaced("50 millis");
const READINESS_LIMIT = "30 seconds";
const MAX_SOCKET_PATH_BYTES = 103;
const ABANDONED = "abandoned";

export const classifyDetachedAppServer = Effect.fn("CodexDetachedAppServers.classify")(function* (
  record: DetachedAppServerRecord,
  dependencies: {
    readonly processTable: DetachedProcessTable;
    readonly socketAccepts: (path: string) => Effect.Effect<boolean, CodexDetachedAppServerError>;
    readonly onVerified?: (pgid: number) => void;
  },
): Effect.fn.Return<DetachedClassification> {
  if (record.pgid === undefined) return { type: "unverifiable" };
  const pgid = record.pgid;
  return yield* Effect.gen(function* () {
    const accepting = yield* dependencies.socketAccepts(record.socketPath);
    const owner = accepting
      ? yield* dependencies.processTable.ownerOfSocket(record.socketPath)
      : undefined;
    if (owner && owner.pgid !== pgid) {
      const recordedMembers = yield* dependencies.processTable.groupMembers(pgid);
      if (recordedMembers.some((member) => member.argv.includes(record.socketPath)))
        return { type: "unverifiable" } as const;
    }
    return yield* dependencies.processTable.groupMembers(owner?.pgid ?? pgid).pipe(
      Effect.map((members) => {
        const matching = members.filter((member) => member.argv.includes(record.socketPath));
        if (accepting) {
          if (!owner || !owner.argv.includes(record.socketPath))
            return { type: "unverifiable" } as const;
          if (!matching.some((member) => member.pid === owner.pid))
            return { type: "unverifiable" } as const;
          dependencies.onVerified?.(owner.pgid);
          return { type: "verified", pgid: owner.pgid, members } as const;
        }
        if (matching.length > 0) {
          dependencies.onVerified?.(pgid);
          return { type: "verified", pgid, members } as const;
        }
        if (members.length === 0) return { type: "gone" } as const;
        if (members.some((member) => member.pid === record.pgid))
          return { type: "mismatch" } as const;
        return { type: "gone", possibleLeftovers: members.map((member) => member.pid) } as const;
      }),
    );
  }).pipe(Effect.orElseSucceed(() => ({ type: "unverifiable" }) as const));
});

export interface DetachedLaunchInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly pidFile: string;
  readonly stderrPath: string;
}

export interface DetachedLaunched {
  readonly pid: number;
  readonly signalIfAlive?: (signal: "SIGTERM" | "SIGKILL") => boolean;
  /** Completes with the exit code once the launched process exits. */
  readonly exited: Effect.Effect<number | null>;
}

export interface DetachedAppServersDependencies {
  readonly stateDir: string;
  readonly bootId: Effect.Effect<string | null, CodexDetachedAppServerError>;
  readonly processTable: DetachedProcessTable;
  readonly socketAccepts: (path: string) => Effect.Effect<boolean, CodexDetachedAppServerError>;
  readonly signalGroup: (
    pgid: number,
    signal: "SIGTERM" | "SIGKILL",
  ) => Effect.Effect<void, CodexDetachedAppServerError>;
  readonly warnPossibleLeftovers?: (pids: ReadonlyArray<number>) => Effect.Effect<void>;
  readonly launch?: (
    input: DetachedLaunchInput,
  ) => Effect.Effect<DetachedLaunched, CodexDetachedAppServerError>;
  readonly connect?: (
    socketPath: string,
  ) => Effect.Effect<CodexAppServerMessageChannel, CodexDetachedAppServerError, Scope.Scope>;
  /** Private directory for socket aliases; Codex limits socket paths to 103 bytes. */
  readonly socketDirectory?: Effect.Effect<string, CodexDetachedAppServerError>;
}

export interface DetachedOpenInput {
  readonly instanceId: string;
  readonly providerSessionId: ProviderSessionId;
  /** Builds the wrapped launch once the socket path is known (the path goes into argv). */
  readonly command: (
    socketPath: string,
  ) => Effect.Effect<
    { readonly command: string; readonly args: ReadonlyArray<string> },
    CodexDetachedAppServerError
  >;
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
}

const randomHex = (bytes: number) => NodeCrypto.randomBytes(bytes).toString("hex");

const tryIo = <A>(detail: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new CodexDetachedAppServerError({ detail, cause }),
  });

const isErrno = (cause: unknown, code: string) =>
  typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === code;

export const makeDetachedAppServers = Effect.fn("CodexDetachedAppServers.make")(function* (
  deps: DetachedAppServersDependencies,
) {
  const directory = NodePath.join(deps.stateDir, RECORD_DIRECTORY);
  const runSync = Effect.runSyncWith(yield* Effect.context<never>());
  const owned = new Map<string, DetachedLaunched>();
  const stopping = new Map<string, DetachedAppServerRecord>();
  const launching = new Set<string>();
  const retained = new Set<string>();
  const recoveryRetained = new Set<string>();
  /** Kept records settleKept released; their fences still refuse the threads they name. */
  const released = new Set<string>();
  const adoptedClosed = new Set<string>();
  // One gate keeps infrequent record writes and cross-instance fence checks atomic.
  const recordGate = yield* Semaphore.make(1);
  const fences = new Map<string, DetachedAppServerRecord>();
  const failedFences = new Map<string, ThreadId>();
  const shuttingDown = yield* Ref.make(false);
  const blocked = yield* Ref.make(new Map<string, DetachedAppServerRecord>());
  /** Set when a record cannot be attributed to a provider instance or the records cannot be listed. */
  const globallyBlocked = yield* Ref.make<string | undefined>(undefined);
  const warn = deps.warnPossibleLeftovers ?? (() => Effect.void);
  const paths = (name: string) => ({
    record: NodePath.join(directory, name + ".json"),
    pid: NodePath.join(directory, name + ".pid"),
    stderr: NodePath.join(directory, name + ".stderr.log"),
  });

  const ensureDirectory = tryIo("Could not create the Codex record directory.", () =>
    NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 }),
  );

  const writeRecordUnlocked = Effect.fn("CodexDetachedAppServers.writeRecord")(function* (
    record: DetachedAppServerRecord,
  ) {
    yield* ensureDirectory;
    const target = paths(record.name).record;
    const temporary = target + "." + randomHex(4) + ".tmp";
    yield* tryIo("Could not write a Codex process record.", async () => {
      await NodeFSP.writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
      await NodeFSP.rename(temporary, target);
    });
  });

  const writeRecord = (record: DetachedAppServerRecord) =>
    recordGate.withPermit(
      Effect.gen(function* () {
        const previous =
          record.state === "spawning" ? undefined : yield* readRecord(paths(record.name).record);
        const next =
          previous === undefined
            ? record
            : {
                ...record,
                providerSessionId: record.providerSessionId ?? previous.providerSessionId,
                stopObligations: previous.stopObligations,
                goalBlocks: previous.goalBlocks,
              };
        yield* writeRecordUnlocked(next);
        fences.set(next.name, next);
      }),
    );

  const removeRecord = (record: DetachedAppServerRecord) =>
    recordGate.withPermit(
      tryIo("Could not remove a Codex process record.", async () => {
        const files = paths(record.name);
        // GOAT's alias in its private socket directory; Codex removes its own socket on a clean exit.
        await NodeFSP.rm(record.socketPath, { force: true });
        await NodeFSP.rm(files.record, { force: true });
        await NodeFSP.rm(files.pid, { force: true });
        await NodeFSP.rm(files.stderr, { force: true });
        fences.delete(record.name);
        recoveryRetained.delete(record.name);
        released.delete(record.name);
      }),
    );

  const readPidFile = (name: string) =>
    tryIo("Could not read a Codex pid file.", async () => {
      try {
        return await NodeFSP.readFile(paths(name).pid, "utf8");
      } catch (cause) {
        if (isErrno(cause, "ENOENT")) return undefined;
        throw cause;
      }
    });

  /** link(2) fails when the name exists, so either startup or the launch shell owns the pid file. */
  const claimPidFile = (name: string) =>
    tryIo("Could not claim a Codex pid file.", async () => {
      const target = paths(name).pid;
      const temporary = target + "." + randomHex(4) + ".claim";
      await NodeFSP.writeFile(temporary, ABANDONED, { mode: 0o600 });
      try {
        await NodeFSP.link(temporary, target);
        return true;
      } catch (cause) {
        if (isErrno(cause, "EEXIST")) return false;
        throw cause;
      } finally {
        await NodeFSP.rm(temporary, { force: true });
      }
    });

  const classify = (record: DetachedAppServerRecord, signal?: "SIGTERM" | "SIGKILL") =>
    classifyDetachedAppServer(record, {
      processTable: deps.processTable,
      socketAccepts: deps.socketAccepts,
      ...(signal === undefined
        ? {}
        : {
            onVerified: (pgid: number) => {
              // Without pidfd on macOS, reuse still requires a new group leader in this final read-to-signal window.
              runSync(deps.signalGroup(pgid, signal).pipe(Effect.ignore));
            },
          }),
    });

  const signalOwned = (record: DetachedAppServerRecord, signal: "SIGTERM" | "SIGKILL") =>
    Effect.try({
      try: () => owned.get(record.name)?.signalIfAlive?.(signal) ?? false,
      catch: (cause) =>
        new CodexDetachedAppServerError({ detail: "Could not signal Codex app-server.", cause }),
    }).pipe(Effect.orElseSucceed(() => false));

  const settledOrGone = (record: DetachedAppServerRecord) =>
    classify(record).pipe(
      Effect.map(
        (result) =>
          (result.type === "gone" && !result.possibleLeftovers?.length) ||
          result.type === "mismatch",
      ),
    );

  const awaitGone = (record: DetachedAppServerRecord) =>
    settledOrGone(record).pipe(
      Effect.repeat({ schedule: POLL, until: (gone) => gone }),
      Effect.timeoutOption(TERM_GRACE),
      Effect.map((result) => result._tag === "Some" && result.value),
    );

  const markBlocked = (record: DetachedAppServerRecord) =>
    Ref.update(blocked, (current) => new Map(current).set(record.name, record)).pipe(
      Effect.as("blocked" as const),
    );

  const finishGone = Effect.fn("CodexDetachedAppServers.finishGone")(function* (
    record: DetachedAppServerRecord,
    classification: DetachedClassification,
  ) {
    if (classification.type === "gone" && classification.possibleLeftovers?.length) {
      yield* warn(classification.possibleLeftovers);
      return yield* markBlocked(record);
    }
    yield* removeRecord(record);
    yield* Ref.update(blocked, (current) => {
      const next = new Map(current);
      next.delete(record.name);
      return next;
    });
    return "cleaned" as const;
  });

  /** SIGTERM, then SIGKILL, each followed by a bounded wait for the group and socket to disappear. */
  const terminate = Effect.fn("CodexDetachedAppServers.terminate")(function* (
    record: DetachedAppServerRecord,
  ) {
    let pgid = record.pgid;
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      // Re-verified before every signal: the group may have ended and its id been reused meanwhile.
      const current: DetachedAppServerRecord = { ...record, pgid };
      if (!(yield* signalOwned(current, signal))) {
        const classification = yield* classify(current, signal);
        if (classification.type === "gone" && classification.possibleLeftovers?.length) {
          yield* warn(classification.possibleLeftovers);
          return yield* markBlocked(current);
        }
        if (classification.type === "gone" || classification.type === "mismatch")
          return yield* finishGone(current, classification);
        if (classification.type === "unverifiable") return yield* markBlocked(current);
        pgid = classification.pgid;
      }
      if (yield* awaitGone({ ...record, pgid })) return yield* finishGone(record, { type: "gone" });
    }
    return yield* markBlocked({ ...record, pgid });
  });

  const cleanupRecord = Effect.fn("CodexDetachedAppServers.cleanupRecord")(function* (
    record: DetachedAppServerRecord,
  ) {
    const bootId = yield* deps.bootId.pipe(Effect.orElseSucceed(() => null));
    const fromOtherBoot = bootId !== null && record.bootId !== null && bootId !== record.bootId;
    let content = yield* readPidFile(record.name);
    if (content === undefined) {
      if (fromOtherBoot) return yield* finishGone(record, { type: "gone" });
      if (yield* claimPidFile(record.name)) return "tombstoned" as const;
      content = yield* readPidFile(record.name);
    }
    const value = content?.trim() ?? "";
    if (value === ABANDONED)
      return fromOtherBoot ? yield* finishGone(record, { type: "gone" }) : ("tombstoned" as const);
    if (!/^\d+$/.test(value)) return yield* markBlocked(record);
    return yield* terminate({ ...record, pgid: Number(value) });
  });

  const readRecord = (file: string) =>
    tryIo("Could not read a Codex process record.", async () =>
      decodeRecord(JSON.parse(await NodeFSP.readFile(file, "utf8"))),
    );

  const classifyRecord = Effect.fn("CodexDetachedAppServers.classifyRecord")(function* (
    key: CodexInstanceRecordKey,
  ) {
    if (key.recordName !== NodePath.basename(key.recordName))
      return { type: "unverifiable" as const };
    const record = yield* readRecord(paths(key.recordName).record).pipe(Effect.option);
    if (record._tag === "None" || record.value.name !== key.recordName)
      return { type: "unverifiable" as const };
    if (record.value.instanceId !== key.instanceId) return { type: "mismatch" as const };
    if (record.value.state === "spawning") return { type: "unverifiable" as const };
    return yield* classify(record.value);
  });

  const mutateFence = (
    key: CodexInstanceRecordKey,
    change: (record: DetachedAppServerRecord) => DetachedAppServerRecord,
  ) =>
    recordGate.withPermit(
      Effect.gen(function* () {
        const record = yield* readRecord(paths(key.recordName).record);
        if (record.name !== key.recordName || record.instanceId !== key.instanceId)
          return yield* new CodexDetachedAppServerError({
            detail: "The Codex process record does not match this provider.",
          });
        const next = change(record);
        yield* writeRecordUnlocked(next);
        fences.set(next.name, next);
      }),
    );

  const recordStopObligation = (key: CodexInstanceRecordKey, stop: CodexStopObligation) =>
    Effect.sync(() => {
      failedFences.set(stopKey(key, stop), stop.threadId);
    }).pipe(
      Effect.andThen(
        mutateFence(key, (record) => ({
          ...record,
          stopObligations: [
            ...(record.stopObligations ?? []).filter((entry) => !sameStop(entry, stop)),
            stop,
          ],
        })),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          failedFences.delete(stopKey(key, stop));
        }),
      ),
    );
  /** `releaseGoal` drops the goal block of the stop's native thread in the same write. */
  const clearStopObligation = (
    key: CodexInstanceRecordKey,
    stop: CodexStopObligation,
    releaseGoal = false,
  ) =>
    mutateFence(key, (record) => ({
      ...record,
      stopObligations: (record.stopObligations ?? []).filter((entry) => !sameStop(entry, stop)),
      ...(releaseGoal
        ? { goalBlocks: (record.goalBlocks ?? []).filter((goal) => !sameGoal(goal, stop)) }
        : {}),
    }));
  const assignSession = (key: CodexInstanceRecordKey, providerSessionId: ProviderSessionId) =>
    mutateFence(key, (record) => ({
      ...record,
      providerSessionId: record.providerSessionId ?? providerSessionId,
    })).pipe(Effect.asVoid);
  const recordGoalBlock = (key: CodexInstanceRecordKey, goal: CodexGoalBlock) =>
    Effect.sync(() => {
      failedFences.set(goalKey(key, goal), goal.threadId);
    }).pipe(
      Effect.andThen(
        mutateFence(key, (record) => ({
          ...record,
          goalBlocks: [
            ...(record.goalBlocks ?? []).filter((entry) => !sameGoal(entry, goal)),
            goal,
          ],
        })),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          failedFences.delete(goalKey(key, goal));
        }),
      ),
    );
  const clearGoalBlock = (key: CodexInstanceRecordKey, goal: CodexGoalBlock) =>
    mutateFence(key, (record) => ({
      ...record,
      goalBlocks:
        [...failedFences.values()].includes(goal.threadId) ||
        [...fences.values()].some((entry) =>
          entry.stopObligations?.some((stop) => stop.threadId === goal.threadId),
        )
          ? record.goalBlocks
          : (record.goalBlocks ?? []).filter((entry) => !sameGoal(entry, goal)),
    }));
  const getGoalBlocks = (threadId: ThreadId) =>
    Effect.sync(() =>
      [...fences.values()].flatMap((record) =>
        (record.goalBlocks ?? [])
          .filter((block) => block.threadId === threadId)
          .map((block) => ({ record: recordKey(record), block })),
      ),
    );
  const listGoalBlocksByInstance = Effect.fn("CodexDetachedAppServers.listGoalBlocksByInstance")(
    (instanceId: ProviderInstanceId) =>
      Effect.sync(() =>
        [...fences.values()]
          .filter((record) => record.instanceId === instanceId)
          .flatMap((record) =>
            (record.goalBlocks ?? []).map((block) => ({ record: recordKey(record), block })),
          ),
      ),
  );
  const getStopObligations = (threadId: ThreadId) =>
    Effect.sync(() =>
      [...fences.values()].flatMap((record) =>
        (record.stopObligations ?? [])
          .filter((block) => block.threadId === threadId)
          .map((block) => ({ record: recordKey(record), block })),
      ),
    );
  const hasGoalBlock = (threadId: ThreadId) =>
    Effect.sync(() =>
      [...fences.values()].some((record) =>
        record.goalBlocks?.some((entry) => entry.threadId === threadId),
      ),
    );
  const stopFencedThreads = Effect.sync(() => [
    ...new Set([
      ...[...failedFences]
        .filter(([key]) => key.startsWith('["stop",'))
        .map(([, threadId]) => threadId),
      ...[...fences.values()].flatMap((record) =>
        (record.stopObligations ?? []).map((entry) => entry.threadId),
      ),
    ]),
  ]);
  const loadRecords = Effect.gen(function* () {
    yield* Ref.set(globallyBlocked, "Codex process records have not been loaded.");
    const entries = yield* tryIo("Could not list Codex process records.", async () => {
      try {
        return await NodeFSP.readdir(directory);
      } catch (cause) {
        if (isErrno(cause, "ENOENT")) return [];
        throw cause;
      }
    });
    const records: DetachedAppServerRecord[] = [];
    let unreadable: string | undefined;
    for (const entry of entries.filter((value) => value.endsWith(".json")).sort()) {
      const name = entry.slice(0, -5);
      const result = yield* readRecord(NodePath.join(directory, entry)).pipe(Effect.option);
      if (result._tag === "None" || result.value.name !== name) {
        unreadable = "A Codex process record (" + name + ") is unreadable.";
        continue;
      }
      fences.set(name, result.value);
      records.push(result.value);
    }
    yield* Ref.set(globallyBlocked, unreadable);
    const result: typeof records & { readonly globalBlock?: string } = records;
    if (unreadable !== undefined)
      Object.defineProperty(result, "globalBlock", { value: unreadable });
    return result;
  }).pipe(Effect.withSpan("CodexDetachedAppServers.loadRecords"));

  /** Startup barrier: every record left by an earlier server run is cleaned, tombstoned or blocked. */
  const cleanup = Effect.gen(function* () {
    yield* Ref.set(globallyBlocked, "Codex process cleanup did not complete.");
    let unreadable = false;
    const entries = yield* tryIo("Could not list Codex process records.", async () => {
      try {
        return await NodeFSP.readdir(directory);
      } catch (cause) {
        if (isErrno(cause, "ENOENT")) return [];
        throw cause;
      }
    }).pipe(Effect.tapError((error) => Ref.set(globallyBlocked, error.detail)));
    const outcomes: Array<{ readonly name: string; readonly outcome: DetachedOutcome }> = [];
    for (const entry of entries.filter((name) => name.endsWith(".json")).sort()) {
      const name = entry.slice(0, -".json".length);
      // Cleanup also reruns beside live sessions; only records from earlier runs are reconsidered.
      if (owned.has(name) || launching.has(name)) continue;
      const record = yield* readRecord(NodePath.join(directory, entry)).pipe(Effect.option);
      if (record._tag === "None" || record.value.name !== name) {
        unreadable = true;
        // No trustworthy instance id: any Codex provider could still own this process.
        yield* Ref.set(globallyBlocked, "A Codex process record (" + name + ") is unreadable.");
        outcomes.push({ name, outcome: "blocked" });
        continue;
      }
      fences.set(name, record.value);
      if (
        recoveryRetained.has(name) ||
        (record.value.goalBlocks?.length ?? 0) > 0 ||
        (record.value.stopObligations?.length ?? 0) > 0
      ) {
        const current = yield* classify(record.value);
        if (current.type === "gone" && current.possibleLeftovers?.length)
          yield* warn(current.possibleLeftovers);
        if (current.type === "verified") recoveryRetained.add(name);
        const outcome =
          current.type === "verified"
            ? ("retained" as const)
            : record.value.state === "running" &&
                current.type === "gone" &&
                !current.possibleLeftovers?.length
              ? yield* finishGone(record.value, current)
              : yield* markBlocked(record.value);
        outcomes.push({ name, outcome });
        continue;
      }
      const outcome = yield* cleanupRecord(record.value);
      outcomes.push({ name, outcome });
    }
    if (!unreadable) yield* Ref.set(globallyBlocked, undefined);
    return outcomes;
  }).pipe(Effect.withSpan("CodexDetachedAppServers.cleanup"));

  /** A removed or repaired record clears the global block on the next check, without a restart. */
  const retryGlobalBlock = Effect.gen(function* () {
    if ((yield* Ref.get(globallyBlocked)) !== undefined)
      yield* cleanup.pipe(Effect.catchCause(() => Effect.void));
    return yield* Ref.get(globallyBlocked);
  });

  const ensureNotBlocked = Effect.fn("CodexDetachedAppServers.ensureNotBlocked")(function* (
    instanceId: string,
    providerSessionId: ProviderSessionId,
  ) {
    const global = yield* retryGlobalBlock;
    if (global !== undefined)
      return yield* new CodexDetachedAppServerError({
        detail:
          global +
          " GOAT will not start Codex until it can confirm no process from before the restart is still running.",
      });
    for (const record of (yield* Ref.get(blocked)).values()) {
      if (!blocksSession(record, instanceId, providerSessionId)) continue;
      const outcome = yield* cleanupRecord(record).pipe(
        Effect.orElseSucceed(() => "blocked" as const),
      );
      if (outcome === "blocked")
        return yield* new CodexDetachedAppServerError({
          detail:
            "A Codex process from before the restart" +
            (record.pgid === undefined ? "" : " (group " + record.pgid + ")") +
            " is still running and could not be stopped. GOAT will not start Codex for this provider until it stops.",
        });
    }
    if (
      [...stopping.values()].some((record) => blocksSession(record, instanceId, providerSessionId))
    )
      return yield* new CodexDetachedAppServerError({
        detail:
          "A Codex process for this session is still stopping. GOAT will not start another one until it exits.",
      });
    const unassigned = [...recoveryRetained].some((name) => {
      const record = fences.get(name);
      return record?.instanceId === instanceId && record.providerSessionId === undefined;
    });
    if (unassigned)
      return yield* new CodexDetachedAppServerError({
        detail:
          "A Codex process from before the restart is still running work GOAT cannot assign to one session. GOAT will not start Codex for this provider until it stops.",
      });
  }, Effect.asVoid);

  const ensureAdmission = Effect.fn("CodexDetachedAppServers.ensureAdmission")(function* (
    threadId: ThreadId,
    options?: { readonly allowGoalControl?: boolean; readonly stdio?: boolean },
  ) {
    const global = yield* retryGlobalBlock;
    const goal = yield* hasGoalBlock(threadId);
    const stopped =
      [...failedFences.values()].includes(threadId) ||
      [...fences.values()].some((record) =>
        record.stopObligations?.some((entry) => entry.threadId === threadId),
      );
    // A stdio turn opens no detached process, so only a known fence on its own thread conflicts.
    if (global !== undefined && !(options?.stdio === true && !stopped && !goal))
      return yield* new CodexDetachedAppServerError({ detail: global });
    if (stopped || (goal && !options?.allowGoalControl))
      return yield* new CodexDetachedAppServerError({
        detail: stopped
          ? "Codex is running work on this thread from before the restart."
          : "Codex is still running a goal on this thread from before the restart. Send /goal pause or /goal clear to continue here.",
      });
  });

  /** Server shutdown signals and moves on; any other close waits for the group to exit. */
  const close = Effect.fn("CodexDetachedAppServers.close")(function* (
    record: DetachedAppServerRecord,
  ) {
    if (!(yield* Ref.get(shuttingDown))) return { outcome: yield* terminate(record) };
    if (retained.has(record.name)) return { outcome: "retained" as const };
    if (!(yield* signalOwned(record, "SIGTERM"))) {
      const classification = yield* classify(record, "SIGTERM").pipe(
        Effect.timeoutOption("1 second"),
      );
      if (classification._tag === "None" || classification.value.type !== "verified")
        return { outcome: "blocked" as const };
    }
    const exists = yield* tryIo("Could not check a Codex process record.", () =>
      NodeFSP.access(paths(record.name).record).then(
        () => true,
        () => false,
      ),
    );
    if (exists) yield* writeRecord({ ...record, state: "terminating" }).pipe(Effect.ignore);
    return { outcome: "signalled" as const };
  });

  const closeFinalizer = (record: DetachedAppServerRecord) =>
    Effect.suspend(() => {
      stopping.set(record.name, record);
      return close(record).pipe(
        Effect.catch(() => markBlocked(record)),
        Effect.ignore,
        Effect.ensuring(Effect.sync(() => stopping.delete(record.name))),
      );
    });

  const socketDirectory =
    deps.socketDirectory ??
    Effect.fail(new CodexDetachedAppServerError({ detail: "No socket directory configured." }));

  /**
   * Spawns a detached app-server and connects to it. Fails with a reason the caller logs before
   * falling back to stdio; never leaves an unrecorded process behind.
   */
  const open = Effect.fn("CodexDetachedAppServers.open")(function* (input: DetachedOpenInput) {
    const launch = deps.launch;
    const connect = deps.connect;
    if (launch === undefined || connect === undefined)
      return yield* new CodexDetachedAppServerError({ detail: "Detached launch is unavailable." });
    const socketDir = yield* socketDirectory;
    const socketPath = NodePath.join(socketDir, randomHex(12) + ".sock");
    if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES)
      return yield* new CodexDetachedAppServerError({
        detail: "The Codex socket path would exceed " + MAX_SOCKET_PATH_BYTES + " bytes.",
      });
    const name = encodeURIComponent(input.instanceId) + "-" + randomHex(6);
    const files = paths(name);
    const bootId = yield* deps.bootId.pipe(Effect.orElseSucceed(() => null));
    const spawning: DetachedAppServerRecord = {
      version: 1,
      instanceId: input.instanceId,
      providerSessionId: input.providerSessionId,
      name,
      socketPath,
      bootId,
      state: "spawning",
      stderrMode: "discard",
      createdAt: DateTime.formatIso(yield* DateTime.now),
    };
    launching.add(name);
    const launched = yield* Effect.gen(function* () {
      yield* writeRecord(spawning);
      const wrapped = yield* input
        .command(socketPath)
        .pipe(Effect.tapError(() => removeRecord(spawning).pipe(Effect.ignore)));
      const started = yield* launch({
        command: wrapped.command,
        args: wrapped.args,
        cwd: input.cwd,
        env: input.env,
        pidFile: files.pid,
        stderrPath: files.stderr,
      }).pipe(Effect.tapError(() => cleanupRecord(spawning).pipe(Effect.ignore)));
      return started;
    }).pipe(Effect.onError(() => Effect.sync(() => launching.delete(name))));
    const running: DetachedAppServerRecord = { ...spawning, pgid: launched.pid, state: "running" };
    owned.set(running.name, launched);
    launching.delete(name);
    yield* Effect.addFinalizer(() =>
      closeFinalizer(running).pipe(Effect.ensuring(Effect.sync(() => owned.delete(running.name)))),
    );
    yield* writeRecord(running);
    const channel = yield* connect(socketPath).pipe(
      Effect.retry(READINESS),
      Effect.timeoutOption(READINESS_LIMIT),
      Effect.raceFirst(
        launched.exited.pipe(
          Effect.flatMap((code) =>
            Effect.fail(
              new CodexDetachedAppServerError({
                detail:
                  "Codex app-server exited before it accepted connections (code " +
                  String(code) +
                  "). Run codex app-server manually to diagnose the failure.",
              }),
            ),
          ),
        ),
      ),
      Effect.flatMap((result) =>
        result._tag === "Some"
          ? Effect.succeed(result.value)
          : Effect.fail(
              new CodexDetachedAppServerError({
                detail: "Codex app-server did not accept connections within 30 seconds.",
              }),
            ),
      ),
    );
    return { channel, record: running };
  });

  const preserveForRecovery = Effect.fn("CodexDetachedAppServers.preserveForRecovery")(function* (
    name: string,
  ) {
    const record = fences.get(name);
    if (
      !record ||
      record.stderrMode !== "discard" ||
      record.state !== "running" ||
      (yield* classify(record)).type !== "verified"
    )
      return yield* new CodexDetachedAppServerError({
        detail: "The Codex process cannot be preserved for recovery.",
      });
    recoveryRetained.add(name);
  });

  const listPreservedForSession = Effect.fn("CodexDetachedAppServers.listPreservedForSession")(
    (instanceId: string, providerSessionId: ProviderSessionId) =>
      Effect.sync(() =>
        [...recoveryRetained].filter((name) => {
          const record = fences.get(name);
          return record !== undefined && servesSession(record, instanceId, providerSessionId);
        }),
      ),
  );

  /** When a kept process started, as its record says. */
  const keptStartedAt = (name: string) =>
    Effect.sync(() => Date.parse(fences.get(name)?.createdAt ?? "") || undefined);

  /**
   * A kept record whose group exited stops being offered for recovery, so the session starts
   * afresh. Its file stays for fence writes and startup cleanup settles it, as it does any gone record.
   */
  const settleKept = (input: KeptRecord.KeptRecordOpen) =>
    KeptRecord.settleKeptRecord({
      ...input,
      record: fences.get(input.name),
      busy: owned.has(input.name) || launching.has(input.name) || stopping.has(input.name),
      globallyBlocked: Ref.get(globallyBlocked),
      classify: (record) => classify(record),
      warn,
      // Under the gate: a fence for this thread written or in flight meanwhile still refuses.
      release: (threadId) =>
        recordGate.withPermit(Effect.sync(() => releases.release(input.name, threadId))),
    });
  const releases = KeptRecord.makeReleases({ fences, failedFences, recoveryRetained, released });
  /** Before a spawn: a released record of this session still refuses a thread it fences. */
  const ensureReleasedClear = (
    instanceId: string,
    session: ProviderSessionId,
    threadId: ThreadId,
  ) =>
    recordGate.withPermit(
      Effect.suspend(() => releases.ensureClear(instanceId, session, threadId)),
    );

  /**
   * Without a session this is a status probe, whose close never touches the process. A session
   * adopts it: closing outside shutdown stops it like an owned one, unless a goal still runs there.
   */
  const connectExisting = Effect.fn("CodexDetachedAppServers.connectExisting")(function* (
    instanceId: string,
    name: string,
    providerSessionId?: ProviderSessionId,
  ) {
    const record = fences.get(name);
    const global = yield* Ref.get(globallyBlocked);
    if (
      global !== undefined ||
      record?.instanceId !== instanceId ||
      record.stderrMode !== "discard" ||
      record.state !== "running" ||
      (providerSessionId !== undefined && !servesSession(record, instanceId, providerSessionId)) ||
      deps.connect === undefined
    )
      return yield* new CodexDetachedAppServerError({
        detail: "The existing Codex process cannot be verified for recovery.",
      });
    const before = yield* classify(record);
    if (before.type !== "verified")
      return yield* new CodexDetachedAppServerError({
        detail: "The existing Codex process cannot be verified for recovery.",
      });
    const channel = yield* deps.connect(record.socketPath);
    const after = yield* classify(record);
    if (after.type !== "verified" || after.pgid !== before.pgid)
      return yield* new CodexDetachedAppServerError({
        detail: "The existing Codex process changed while connecting.",
      });
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        if (adoptedClosed.has(name) || providerSessionId === undefined) return;
        const current = { ...(fences.get(name) ?? record), pgid: after.pgid };
        if (!(yield* Ref.get(shuttingDown)) && (current.goalBlocks?.length ?? 0) > 0) return;
        adoptedClosed.add(name);
        yield* closeFinalizer(current);
      }),
    );
    return { channel, record: { ...record, pgid: after.pgid } };
  });

  const retainOnClose = Effect.fn("CodexDetachedAppServers.retainOnClose")(function* (
    name: string,
    decision: {
      readonly setting: "off" | "restart" | "always";
      readonly stopKind: "restart" | "quit";
      readonly prepared: boolean;
    },
  ) {
    if (
      !decision.prepared ||
      decision.setting === "off" ||
      (decision.setting === "restart" && decision.stopKind !== "restart")
    ) {
      retained.delete(name);
      return false;
    }
    const record = fences.get(name);
    if (
      (!owned.has(name) && !recoveryRetained.has(name)) ||
      record?.stderrMode !== "discard" ||
      (!owned.has(name) && (yield* classify(record)).type !== "verified")
    )
      return yield* new CodexDetachedAppServerError({
        detail: "The Codex process cannot be retained safely.",
      });
    retained.add(name);
    return true;
  });

  return {
    cleanup,
    loadRecords,
    classifyRecord,
    connectExisting,
    preserveForRecovery,
    listPreservedForSession,
    keptStartedAt,
    settleKept,
    ensureReleasedClear,
    retainOnClose,
    recordStopObligation,
    clearStopObligation,
    assignSession,
    getStopObligations,
    stopFencedThreads,
    getGoalBlocks,
    listGoalBlocksByInstance,
    recordGoalBlock,
    clearGoalBlock,
    hasGoalBlock,
    ensureAdmission,
    ensureNotBlocked,
    close,
    open,
    beginServerShutdown: Ref.set(shuttingDown, true),
  };
});

export type DetachedAppServers = Effect.Success<ReturnType<typeof makeDetachedAppServers>>;
