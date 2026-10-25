// @effect-diagnostics nodeBuiltinImport:off -- reads other GOAT servers' databases read-only.
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
 * A GOAT server: `goat serve`, an older build StrayProcesses also recognises by its home, or the
 * server entry the desktop app and dev runner start.
 */
export function looksLikeGoatServer(command: string): boolean {
  return (
    serveBaseDir(command) !== null ||
    (/goat/iu.test(command) && /(?:^|\s)serve(?:\s|$)/u.test(command)) ||
    /[/\\]apps[/\\]server[/\\](?:dist|src)[/\\]bin\.(?:mjs|js|ts)(?:\s|$)/u.test(command)
  );
}

/** `lsof -F pn` output: which database files each process holds open. */
export function databasesByPid(lsofOutput: string): ReadonlyMap<number, ReadonlyArray<string>> {
  const result = new Map<number, Array<string>>();
  let pid: number | null = null;
  for (const line of lsofOutput.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid !== null && line.endsWith("statev2.sqlite"))
      result.set(pid, [...(result.get(pid) ?? []), line.slice(1)]);
  }
  return result;
}

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

export const readOtherServerBindings = Effect.fn("localGoatServers.readOtherServerBindings")(
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
    for (const goatHome of [
      env.GOAT_HOME,
      path.join(home, ".goat"),
      path.join(home, ".goat", "desktop"),
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
      const servers = rows.filter(
        (row) => row.uid === uid && row.pid !== process.pid && looksLikeGoatServer(row.command),
      );
      const open = new Map<number, ReadonlyArray<string>>();
      if (servers.length > 0 && platform === "darwin") {
        const lsof = yield* runner
          .run({
            command: "lsof",
            args: ["-a", "-p", servers.map((row) => row.pid).join(","), "-F", "pn"],
            env: { LC_ALL: "C" },
            timeout: Duration.seconds(10),
            maxOutputBytes: 16 * 1024 * 1024,
          })
          .pipe(Effect.option);
        // lsof exits 1 when one of several pids has already exited; its output still holds the rest.
        if (lsof._tag === "Some")
          for (const [pid, files] of databasesByPid(lsof.value.stdout)) open.set(pid, files);
      } else if (servers.length > 0) {
        for (const row of servers) {
          const fds = path.join("/proc", String(row.pid), "fd");
          const names = yield* fs.readDirectory(fds).pipe(Effect.orElseSucceed(() => []));
          const files: Array<string> = [];
          for (const name of names) {
            const target = yield* fs
              .readLink(path.join(fds, name))
              .pipe(Effect.orElseSucceed(() => ""));
            if (target.endsWith("statev2.sqlite")) files.push(target);
          }
          open.set(row.pid, files);
        }
      }
      for (const row of servers) {
        const files = open.get(row.pid) ?? [];
        if (files.length === 0)
          unverified.push(
            "GOAT server process " + row.pid + " has no database this check could find",
          );
        for (const file of files) candidates.add(file);
      }
    }

    const own = yield* real(input.ownDatabase);
    const seen = new Set<string>([own]);
    const databases: Array<string> = [];
    const worktreePaths: Array<string> = [];
    const projectRoots: Array<string> = [];
    for (const candidate of candidates) {
      if (!(yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false)))) continue;
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
 * The working folder of every process of this user, or null when they cannot all be listed.
 * A shell, an agent CLI or a build of any GOAT server running inside a checkout shows here.
 */
export const processWorkingDirectories = Effect.fn("localGoatServers.processWorkingDirectories")(
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
          args: ["-a", "-d", "cwd", "-u", String(uid), "-F", "n"],
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
