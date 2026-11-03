// @effect-diagnostics nodeBuiltinImport:off -- ownership records need link(2) and O_EXCL semantics that FileSystem does not expose.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import type { CodexAppServerMessageChannel } from "effect-codex-app-server/client";

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
  readonly name: string;
  readonly socketPath: string;
  readonly pgid?: number | undefined;
  readonly bootId: string | null;
  readonly state: "spawning" | "running" | "terminating";
  readonly createdAt: string;
}

const DetachedRecordSchema = Schema.Struct({
  version: Schema.Literal(1),
  instanceId: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  socketPath: Schema.NonEmptyString,
  pgid: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  bootId: Schema.NullOr(Schema.String),
  state: Schema.Literals(["spawning", "running", "terminating"]),
  createdAt: Schema.String,
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

export type DetachedOutcome = "cleaned" | "tombstoned" | "blocked" | "signalled";

export class CodexDetachedAppServerError extends Schema.TaggedError<CodexDetachedAppServerError>()(
  "CodexDetachedAppServerError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return this.detail;
  }
}

const RECORD_DIRECTORY = "codex-app-servers";
const TERM_GRACE = "5 seconds";
const POLL = Schedule.spaced("250 millis");
const READINESS = Schedule.spaced("50 millis");
const READINESS_LIMIT = "30 seconds";
const MAX_SOCKET_PATH_BYTES = 103;
const ABANDONED = "abandoned";

/** Runs as the detached group leader: publishes its pid with link(2), then execs Codex in place. */
export const PID_HANDSHAKE_SCRIPT = `printf %s "$$" > "$1.$$" && ln "$1.$$" "$1" || { rm -f "$1.$$"; exit 75; }
rm -f "$1.$$"
fifo="$1.err"
log="$2"
command -v tail >/dev/null && mkfifo "$fifo" || { printf '%s\\n' 'Could not create Codex stderr FIFO.' > "$log"; exit 76; }
/bin/sh -c 'tail -c 65536 <"$1" >"$2"; : >"$2.done"' goat-codex-log "$fifo" "$log" </dev/null &
exec 3>"$fifo"
rm -f "$fifo"
shift 2
exec "$@" 2>&3 3>&-`;

/** Creates root/codex with mode 0700 and refuses a directory another user could write to. */
export const privateSocketDirectory = (root: string, uid: number) =>
  Effect.tryPromise({
    try: async () => {
      const directory = NodePath.join(root, "codex");
      await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
      for (const path of [root, directory]) {
        const stat = await NodeFSP.lstat(path);
        if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o077) !== 0)
          throw new Error(path + " must be a private directory owned by this user.");
      }
      return directory;
    },
    catch: (cause) =>
      new CodexDetachedAppServerError({
        detail: "The Codex socket directory is not private.",
        cause,
      }),
  });

export const classifyDetachedAppServer = Effect.fn("CodexDetachedAppServers.classify")(function* (
  record: DetachedAppServerRecord,
  dependencies: {
    readonly processTable: DetachedProcessTable;
    readonly socketAccepts: (path: string) => Effect.Effect<boolean, CodexDetachedAppServerError>;
  },
): Effect.fn.Return<DetachedClassification> {
  if (record.pgid === undefined) return { type: "unverifiable" };
  const pgid = record.pgid;
  return yield* Effect.gen(function* () {
    const members = yield* dependencies.processTable.groupMembers(pgid);
    const accepting = yield* dependencies.socketAccepts(record.socketPath);
    const owner = accepting
      ? yield* dependencies.processTable.ownerOfSocket(record.socketPath)
      : undefined;
    const matching = members.filter((member) => member.argv.includes(record.socketPath));
    if (accepting) {
      if (!owner || !owner.argv.includes(record.socketPath))
        return { type: "unverifiable" } as const;
      if (matching.length > 0 && owner.pgid !== record.pgid)
        return { type: "unverifiable" } as const;
      return { type: "verified", pgid: owner.pgid, members } as const;
    }
    if (matching.length > 0) return { type: "verified", pgid, members } as const;
    if (members.length === 0) return { type: "gone" } as const;
    // A live leader without our socket path means the id now belongs to another process group.
    if (members.some((member) => member.pid === record.pgid)) return { type: "mismatch" } as const;
    // Without the socket path nothing proves these belong to our spawn (the id may have been reused
    // after our group ended), so they are reported, never signalled.
    return { type: "gone", possibleLeftovers: members.map((member) => member.pid) } as const;
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

/** Reads at most the last bytes of the detached stderr log. */
const readTail = async (path: string, bytes: number) => {
  const handle = await NodeFSP.open(path, "r").catch(() => undefined);
  if (handle === undefined) return "";
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
};

const lastStderrLine = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1);

export const makeDetachedAppServers = Effect.fn("CodexDetachedAppServers.make")(function* (
  deps: DetachedAppServersDependencies,
) {
  const directory = NodePath.join(deps.stateDir, RECORD_DIRECTORY);
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

  const writeRecord = Effect.fn("CodexDetachedAppServers.writeRecord")(function* (
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

  const removeRecord = (record: DetachedAppServerRecord) =>
    tryIo("Could not remove a Codex process record.", async () => {
      const files = paths(record.name);
      // GOAT's alias in its private socket directory; Codex removes its own socket on a clean exit.
      await NodeFSP.rm(record.socketPath, { force: true });
      await NodeFSP.rm(files.record, { force: true });
      await NodeFSP.rm(files.pid, { force: true });
      await NodeFSP.rm(files.stderr, { force: true });
      await NodeFSP.rm(files.stderr + ".done", { force: true });
      await NodeFSP.rm(files.pid + ".err", { force: true });
    });

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

  const classify = (record: DetachedAppServerRecord) =>
    classifyDetachedAppServer(record, {
      processTable: deps.processTable,
      socketAccepts: deps.socketAccepts,
    });

  const settledOrGone = (record: DetachedAppServerRecord) =>
    classify(record).pipe(
      Effect.map((result) => result.type === "gone" || result.type === "mismatch"),
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
    if (classification.type === "gone" && classification.possibleLeftovers?.length)
      yield* warn(classification.possibleLeftovers);
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
      const classification = yield* classify(current);
      if (classification.type === "gone" || classification.type === "mismatch")
        return yield* finishGone(current, classification);
      if (classification.type === "unverifiable") return yield* markBlocked(current);
      pgid = classification.pgid;
      yield* deps.signalGroup(pgid, signal).pipe(Effect.ignore);
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
      const record = yield* readRecord(NodePath.join(directory, entry)).pipe(Effect.option);
      if (record._tag === "None" || record.value.name !== name) {
        unreadable = true;
        // No trustworthy instance id: any Codex provider could still own this process.
        yield* Ref.set(globallyBlocked, "A Codex process record (" + name + ") is unreadable.");
        outcomes.push({ name, outcome: "blocked" });
        continue;
      }
      const outcome = yield* cleanupRecord(record.value);
      outcomes.push({ name, outcome });
    }
    if (!unreadable) yield* Ref.set(globallyBlocked, undefined);
    return outcomes;
  }).pipe(Effect.withSpan("CodexDetachedAppServers.cleanup"));

  const ensureNotBlocked = Effect.fn("CodexDetachedAppServers.ensureNotBlocked")(function* (
    instanceId: string,
  ) {
    if ((yield* Ref.get(globallyBlocked)) !== undefined)
      yield* cleanup.pipe(Effect.catchCause(() => Effect.void));
    const global = yield* Ref.get(globallyBlocked);
    if (global !== undefined)
      return yield* new CodexDetachedAppServerError({
        detail:
          global +
          " GOAT will not start Codex until it can confirm no process from before the restart is still running.",
      });
    for (const record of (yield* Ref.get(blocked)).values()) {
      if (record.instanceId !== instanceId) continue;
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
  }, Effect.asVoid);

  /** Server shutdown signals and moves on; any other close waits for the group to exit. */
  const close = Effect.fn("CodexDetachedAppServers.close")(function* (
    record: DetachedAppServerRecord,
  ) {
    if (!(yield* Ref.get(shuttingDown))) return { outcome: yield* terminate(record) };
    // Within the launcher's deadline: one process-table read, and a signal only to a group that
    // still carries this record's socket path. Anything else is left to the next startup.
    const pgid = record.pgid;
    const members =
      pgid === undefined
        ? []
        : yield* deps.processTable.groupMembers(pgid).pipe(
            Effect.timeoutOption("1 second"),
            Effect.map((result) => (result._tag === "Some" ? result.value : [])),
            Effect.orElseSucceed(() => []),
          );
    if (pgid === undefined || !members.some((member) => member.argv.includes(record.socketPath)))
      return { outcome: "blocked" as const };
    yield* deps.signalGroup(pgid, "SIGTERM").pipe(Effect.ignore);
    const exists = yield* tryIo("Could not check a Codex process record.", () =>
      NodeFSP.access(paths(record.name).record).then(
        () => true,
        () => false,
      ),
    );
    if (exists) yield* writeRecord({ ...record, state: "terminating" }).pipe(Effect.ignore);
    return { outcome: "signalled" as const };
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
      name,
      socketPath,
      bootId,
      state: "spawning",
      createdAt: DateTime.formatIso(yield* DateTime.now),
    };
    yield* writeRecord(spawning);
    const wrapped = yield* input
      .command(socketPath)
      .pipe(Effect.tapError(() => removeRecord(spawning).pipe(Effect.ignore)));
    const launched = yield* launch({
      command: wrapped.command,
      args: wrapped.args,
      cwd: input.cwd,
      env: input.env,
      pidFile: files.pid,
      stderrPath: files.stderr,
    }).pipe(Effect.tapError(() => cleanupRecord(spawning).pipe(Effect.ignore)));
    const running: DetachedAppServerRecord = { ...spawning, pgid: launched.pid, state: "running" };
    yield* Effect.addFinalizer(() => close(running).pipe(Effect.ignore));
    yield* writeRecord(running);
    const channel = yield* connect(socketPath).pipe(
      Effect.retry(READINESS),
      Effect.timeoutOption(READINESS_LIMIT),
      Effect.raceFirst(
        launched.exited.pipe(
          Effect.flatMap((code) =>
            tryIo("Could not read the Codex log.", () => readTail(files.stderr, 8192)).pipe(
              Effect.flatMap((stderr) =>
                Effect.fail(
                  new CodexDetachedAppServerError({
                    detail:
                      "Codex app-server exited before it accepted connections (code " +
                      String(code) +
                      ")" +
                      ((line) => (line ? ": " + line : "."))(lastStderrLine(stderr)),
                  }),
                ),
              ),
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

  return {
    cleanup,
    ensureNotBlocked,
    close,
    open,
    beginServerShutdown: Ref.set(shuttingDown, true),
  };
});

export type DetachedAppServers = Effect.Success<ReturnType<typeof makeDetachedAppServers>>;
