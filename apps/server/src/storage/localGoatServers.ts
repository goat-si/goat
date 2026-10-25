// @effect-diagnostics nodeBuiltinImport:off -- reads other GOAT servers' databases read-only.
import * as NodeFSP from "node:fs/promises";
import * as NodeSqlite from "node:sqlite";

import * as HostProcess from "@goat/shared/HostProcess";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { parsePsRows, serveBaseDir, type ProcessRow } from "../diagnostics/StrayProcesses.ts";
import * as ProcessRunner from "../processRunner.ts";

/**
 * Every GOAT server on this machine can bind a thread to a checkout in a folder another server
 * scans: the desktop app (~/.goat/desktop) and a headless server (~/.goat) often share
 * repositories. Before deleting a checkout, the cleanup reads what the other servers' databases
 * bind, and refuses when it cannot be sure it has seen every running one.
 *
 * @module localGoatServers
 */

export interface OtherServerBindings {
  /** Database files read, other than this server's own. */
  readonly databases: ReadonlyArray<string>;
  /** Every worktree path a thread of another server records, whatever the thread's state. */
  readonly worktreePaths: ReadonlyArray<string>;
  /** Folders of the other servers' projects, where their project-folder threads run. */
  readonly projectRoots: ReadonlyArray<string>;
  /** Why some server could not be checked. Non-empty means checkouts must not be deleted. */
  readonly unverified: ReadonlyArray<string>;
}

/**
 * A GOAT server by its command line: `goat`, `goat start` or `goat serve`, an older build
 * StrayProcesses also recognises by its home, or the server entry the desktop app and dev runner
 * start. Discovery also counts any process holding a GOAT database open, whatever its arguments.
 */
export function looksLikeGoatServer(command: string): boolean {
  return (
    serveBaseDir(command) !== null ||
    (/goat/iu.test(command) && /(?:^|\s)serve(?:\s|$)/u.test(command)) ||
    // The entry with no subcommand, only flags, or serve/start runs a server; others (thread start,
    // storage, cua-lease-proxy, pair) do not. Compiled builds name the binary in lower case; the
    // desktop app's own GOAT executable is not a server.
    SERVER_ENTRY.test(command)
  );
}

const SERVER_ARGUMENTS = String.raw`(?:$|\s+(?:-|(?:serve|start)(?:\s|$)))`;
// goat-rename: legacy-begin (older installs still run their server as t3)
const SERVER_ENTRY = new RegExp(
  String.raw`(?:^\S*(?:^|[/\\])(?:goat|t3)(?:\.exe)?|[/\\](?:apps[/\\]server|node_modules[/\\](?:goat|t3))[/\\](?:dist|src)[/\\]bin\.(?:mjs|js|ts))` +
    SERVER_ARGUMENTS,
  "u",
);
// goat-rename: legacy-end

/** A database file a process holds open, as the process sees it. */
export interface HeldDatabase {
  readonly path: string;
  /** The inode it holds, when known; a file at the path with another inode is not the same one. */
  readonly inode: string | null;
  /** Unlinked while held: whatever is at the path now is not what the process reads. */
  readonly deleted: boolean;
}

/** `lsof -F pni` output: which database files each process holds open. */
export function databasesByPid(
  lsofOutput: string,
): ReadonlyMap<number, ReadonlyArray<HeldDatabase>> {
  const result = new Map<number, Array<HeldDatabase>>();
  let pid: number | null = null;
  let inode: string | null = null;
  for (const line of lsofOutput.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    // Each file's fields start with its descriptor; its inode comes before its name.
    else if (line.startsWith("f")) inode = null;
    else if (line.startsWith("i")) inode = line.slice(1);
    else if (line.startsWith("n") && pid !== null && line.endsWith("statev2.sqlite"))
      result.set(pid, [...(result.get(pid) ?? []), { path: line.slice(1), inode, deleted: false }]);
  }
  return result;
}

const LINUX_DELETED = " (deleted)";

interface ReadRows {
  readonly worktreePaths: ReadonlyArray<string>;
  readonly projectRoots: ReadonlyArray<string>;
}

/**
 * One short read-only query pair. Another server writes this database in WAL mode, which lets a
 * read-only reader in without blocking it.
 */
const readDatabase = (file: string) =>
  Effect.try({
    try: (): ReadRows => {
      const db = new NodeSqlite.DatabaseSync(file, { readOnly: true });
      try {
        db.exec("PRAGMA busy_timeout = 2000;");
        const threads = db
          .prepare(
            "SELECT json_extract(payload_json, '$.worktreePath') AS path FROM orchestration_v2_projection_threads WHERE json_extract(payload_json, '$.worktreePath') IS NOT NULL",
          )
          .all();
        const projects = db
          .prepare(
            "SELECT workspace_root AS root FROM projection_projects WHERE deleted_at IS NULL",
          )
          .all();
        return {
          worktreePaths: threads.flatMap((row) => (typeof row.path === "string" ? [row.path] : [])),
          projectRoots: projects.flatMap((row) => (typeof row.root === "string" ? [row.root] : [])),
        };
      } finally {
        db.close();
      }
    },
    catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
  });

/**
 * Whether a database file is there. Only a missing file or folder counts as absent: a folder this
 * user cannot search hides a database without proving there is none.
 */
const presence = (file: string) =>
  NodeFSP.stat(file, { bigint: true }).then(
    (stat) => ({ found: "present" as const, inode: stat.ino.toString() }),
    (error: NodeJS.ErrnoException) => ({
      found:
        error.code === "ENOENT" || error.code === "ENOTDIR"
          ? ("absent" as const)
          : ("unreachable" as const),
      inode: null,
    }),
  );

const readOtherServerBindings = Effect.fn("localGoatServers.readOtherServerBindings")(
  function* (input: { readonly ownDatabase: string }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runner = yield* ProcessRunner.ProcessRunner;
    const platform = yield* HostProcess.Platform;
    const uid = yield* HostProcess.UserId;
    const home = yield* HostProcess.HomeDirectory;
    const env = yield* HostProcess.Environment;
    const unverified: Array<string> = [];
    const real = (value: string) =>
      fs.realPath(value).pipe(Effect.orElseSucceed(() => path.resolve(value)));

    const candidates = new Set<string>();
    // Databases a running process holds open must be there, as the very file it holds; the known
    // homes may not exist.
    const heldOpen = new Map<string, Array<HeldDatabase>>();
    for (const goatHome of [
      env.GOAT_HOME,
      path.join(home, ".goat"),
      path.join(home, ".goat", "desktop"),
      // Packaged nightly and preview builds keep their own home; their threads can still be bound
      // to stable's worktrees.
      path.join(home, ".goat", "desktop-nightly"),
      path.join(home, ".t3"),
    ]) {
      if (goatHome === undefined || goatHome.trim() === "") continue;
      for (const state of ["userdata", "dev"])
        candidates.add(path.join(goatHome, state, "statev2.sqlite"));
    }

    if (platform === "win32" || uid === undefined) {
      unverified.push("this machine's running GOAT servers cannot be listed here");
    } else {
      const listed = yield* runner
        .run({
          command: "ps",
          args: ["-axww", "-o", "pid=,ppid=,uid=,lstart=,command="],
          env: { LC_ALL: "C", TZ: "UTC" },
          timeout: Duration.seconds(5),
          maxOutputBytes: 8 * 1024 * 1024,
        })
        .pipe(Effect.option);
      const rows: ReadonlyArray<ProcessRow> =
        listed._tag === "Some" && listed.value.code === 0 ? parsePsRows(listed.value.stdout) : [];
      if (rows.length === 0) unverified.push("the process list could not be read");
      // Whatever its command line says, a process holding a GOAT database open is a server.
      const open = yield* databasesOpenBy(uid);
      if (open === null) unverified.push("the databases open on this machine could not be listed");
      for (const files of open?.values() ?? [])
        for (const file of files) {
          candidates.add(file.path);
          heldOpen.set(file.path, [...(heldOpen.get(file.path) ?? []), file]);
        }
      const servers = rows.filter(
        (row) => row.uid === uid && row.pid !== process.pid && looksLikeGoatServer(row.command),
      );
      for (const row of servers) {
        const files = open?.get(row.pid) ?? [];
        if (files.length === 0)
          unverified.push(
            "GOAT server process " + row.pid + " has no database this check could find",
          );
        for (const file of files) candidates.add(file.path);
      }
    }

    const own = yield* real(input.ownDatabase);
    const seen = new Set<string>([own]);
    const databases: Array<string> = [];
    const worktreePaths: Array<string> = [];
    const projectRoots: Array<string> = [];
    for (const candidate of candidates) {
      const held = heldOpen.get(candidate) ?? [];
      if (held.some((file) => file.deleted)) {
        unverified.push("the GOAT database " + candidate + " was deleted while a process holds it");
        continue;
      }
      const { found, inode } = yield* Effect.promise(() => presence(candidate));
      if (found === "unreachable") {
        unverified.push("the GOAT database " + candidate + " could not be reached");
        continue;
      }
      if (found === "absent") {
        if (held.length > 0)
          unverified.push("the GOAT database " + candidate + " a process holds open was not found");
        continue;
      }
      if (held.some((file) => file.inode !== null && file.inode !== inode)) {
        unverified.push(
          "the GOAT database " + candidate + " on disk is not the file a process holds open",
        );
        continue;
      }
      const file = yield* real(candidate);
      if (seen.has(file)) continue;
      seen.add(file);
      const rows = yield* readDatabase(file).pipe(Effect.result);
      if (rows._tag === "Failure") {
        unverified.push("the GOAT database " + file + " could not be read (" + rows.failure + ")");
        continue;
      }
      databases.push(file);
      worktreePaths.push(...rows.success.worktreePaths);
      projectRoots.push(...rows.success.projectRoots);
    }
    return { databases, worktreePaths, projectRoots, unverified } satisfies OtherServerBindings;
  },
);

/**
 * The GOAT databases every process of this user holds open, by pid; null when they cannot all be
 * listed. A server keeps its database open while it runs, however it was started.
 */
const databasesOpenBy = Effect.fn("localGoatServers.databasesOpenBy")(function* (uid: number) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const platform = yield* HostProcess.Platform;
  if (platform === "darwin") {
    const listed = yield* runner
      .run({
        command: "lsof",
        // -n and -P skip name lookups for sockets, which otherwise take most of the time.
        args: ["-a", "-u", String(uid), "-n", "-P", "-b", "-w", "-F", "pni"],
        env: { LC_ALL: "C" },
        timeout: Duration.seconds(20),
        maxOutputBytes: 64 * 1024 * 1024,
      })
      .pipe(Effect.option);
    // lsof exits 1 when a process ends while it reads; the rest of its output still stands.
    if (listed._tag === "None" || listed.value.stdout.length === 0) return null;
    return databasesByPid(listed.value.stdout);
  }
  if (platform !== "linux") return null;
  const pids = yield* fs.readDirectory("/proc").pipe(Effect.option);
  if (pids._tag === "None") return null;
  const result = new Map<number, ReadonlyArray<HeldDatabase>>();
  for (const pid of pids.value) {
    if (!/^\d+$/u.test(pid)) continue;
    const owner = yield* fs.stat(path.join("/proc", pid)).pipe(Effect.option);
    if (owner._tag === "None" || owner.value.uid._tag !== "Some" || owner.value.uid.value !== uid)
      continue;
    const fds = path.join("/proc", pid, "fd");
    const files: Array<HeldDatabase> = [];
    for (const name of yield* fs.readDirectory(fds).pipe(Effect.orElseSucceed(() => []))) {
      const target = yield* fs.readLink(path.join(fds, name)).pipe(Effect.orElseSucceed(() => ""));
      // The kernel names a file unlinked while held "<path> (deleted)".
      const deleted = target.endsWith(LINUX_DELETED);
      const held = deleted ? target.slice(0, -LINUX_DELETED.length) : target;
      if (held.endsWith("statev2.sqlite")) files.push({ path: held, inode: null, deleted });
    }
    if (files.length > 0) result.set(Number(pid), files);
  }
  return result;
});

/**
 * The working folder of every process of this user, or null when they cannot all be listed.
 * A shell, an agent CLI or a build of any GOAT server running inside a checkout shows here.
 */
const processWorkingDirectories = Effect.fn("localGoatServers.processWorkingDirectories")(
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runner = yield* ProcessRunner.ProcessRunner;
    const platform = yield* HostProcess.Platform;
    const uid = yield* HostProcess.UserId;
    if (uid === undefined) return null;
    if (platform === "darwin") {
      const listed = yield* runner
        .run({
          command: "lsof",
          args: ["-a", "-d", "cwd", "-u", String(uid), "-n", "-P", "-F", "n"],
          env: { LC_ALL: "C" },
          timeout: Duration.seconds(15),
          maxOutputBytes: 32 * 1024 * 1024,
        })
        .pipe(Effect.option);
      if (listed._tag === "None" || listed.value.stdout.length === 0) return null;
      return listed.value.stdout
        .split("\n")
        .flatMap((line) => (line.startsWith("n") ? [line.slice(1)] : []));
    }
    if (platform !== "linux") return null;
    const pids = yield* fs.readDirectory("/proc").pipe(Effect.option);
    if (pids._tag === "None") return null;
    const result: Array<string> = [];
    for (const pid of pids.value) {
      if (!/^\d+$/u.test(pid)) continue;
      const owner = yield* fs.stat(path.join("/proc", pid)).pipe(Effect.option);
      if (owner._tag === "None" || owner.value.uid._tag !== "Some" || owner.value.uid.value !== uid)
        continue;
      const cwd = yield* fs.readLink(path.join("/proc", pid, "cwd")).pipe(Effect.option);
      if (cwd._tag === "Some") result.push(cwd.value);
    }
    return result;
  },
);

/** The machine-wide reads the storage cleanup depends on, replaceable in tests. */
export class LocalGoatServers extends Context.Service<
  LocalGoatServers,
  {
    readonly otherServers: (ownDatabase: string) => Effect.Effect<OtherServerBindings>;
    readonly workingDirectories: Effect.Effect<ReadonlyArray<string> | null>;
  }
>()("goat/storage/localGoatServers") {}

export const layer = Layer.effect(
  LocalGoatServers,
  Effect.gen(function* () {
    const context = yield* Effect.context<
      FileSystem.FileSystem | Path.Path | ProcessRunner.ProcessRunner
    >();
    return LocalGoatServers.of({
      otherServers: (ownDatabase) =>
        readOtherServerBindings({ ownDatabase }).pipe(Effect.provideContext(context)),
      workingDirectories: processWorkingDirectories().pipe(Effect.provideContext(context)),
    });
  }),
);
