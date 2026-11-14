// @effect-diagnostics nodeBuiltinImport:off -- Synthetic filesystem and attribute-tool fixture.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Config from "../config.ts";
import { backupDatabase, databaseBackupBlocker } from "../serviceLauncherDatabase.ts";
import { initializeV2Database } from "./initializeV2Database.ts";

vi.mock("node:os", async (load) => ({
  ...(await load<typeof NodeOS>()),
  platform: vi.fn(),
}));
vi.mock("node:fs/promises", async (load) => ({
  ...(await load<typeof NodeFSP>()),
  statfs: vi.fn(),
}));
vi.mock("node:child_process", async (load) => ({
  ...(await load<typeof NodeChildProcess>()),
  execFile: vi.fn(),
}));

// Tests control the native watchdog without advancing wall time.
const createToolDeadline = () => new AbortController();

type ToolBehavior = "ok" | "missing" | "denied" | "timeout";

interface ToolCall {
  file: string;
  args: readonly string[];
  existingSqliteFiles: ReadonlyArray<string>;
  killSignal: NodeChildProcess.ExecFileOptions["killSignal"];
}

interface Fixture {
  root: string;
  paths: Config.ServerDerivedPaths;
  attributes: Map<string, boolean>;
  commands: Array<ToolCall>;
  options: { tool: ToolBehavior; clone: boolean; btrfs: boolean; flagsReadable?: false };
  deadline: AbortController;
}

const fixture = <E, R>(use: (context: Fixture) => Effect.Effect<void, E, R>) =>
  Effect.gen(function* () {
    vi.mocked(NodeOS.platform).mockReturnValue("linux");
    const options: { tool: ToolBehavior; clone: boolean; btrfs: boolean; flagsReadable?: false } = {
      tool: "ok",
      clone: true,
      btrfs: true,
    };
    vi.mocked(NodeFSP.statfs).mockImplementation(async () => ({
      type: options.btrfs ? 0x9123683e : 0xef53,
      bsize: 4096,
      blocks: 1,
      bfree: 1,
      bavail: 1,
      files: 1,
      ffree: 1,
    }));
    const root = yield* Effect.acquireRelease(
      Effect.promise(async () =>
        NodeFSP.realpath(await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-btrfs-"))),
      ),
      (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
    );
    const paths = yield* Config.ServerConfig.pipe(Effect.provide(Config.layerTest(root, root)));
    const attributes = new Map<string, boolean>();
    const commands: Array<ToolCall> = [];
    const deadline = createToolDeadline();

    vi.mocked(NodeChildProcess.execFile).mockImplementation((file, args, rawOptions, callback) => {
      const command = args as readonly string[];
      const toolOptions = rawOptions as NodeChildProcess.ExecFileOptions;
      const finish = callback as (error: Error | null, stdout: string, stderr: string) => void;
      const child = Object.assign(new NodeChildProcess.ChildProcess(), { stdio: [] });
      const target = command.at(-1) ?? "";
      commands.push({
        file,
        args: command,
        existingSqliteFiles: ["", "-wal", "-shm"].filter((suffix) =>
          NodeFS.existsSync(`${paths.dbPath}${suffix}`),
        ),
        killSignal: toolOptions?.killSignal,
      });
      queueMicrotask(() => {
        if (file === "chattr" && (options.tool === "missing" || options.tool === "denied")) {
          const code = options.tool === "missing" ? "ENOENT" : "EACCES";
          child.emit("error", Object.assign(new Error(code), { code }));
        } else if (file === "chattr" && options.tool === "timeout") {
          deadline.abort(new DOMException("Simulated deadline", "TimeoutError"));
        } else if (file === "chattr") {
          attributes.set(target, command[0] === "+C");
          finish(null, "", "");
        } else if (file === "lsattr") {
          if (options.flagsReadable === false) {
            finish(null, "unrecognized attribute output", "");
            return;
          }
          finish(
            null,
            `${attributes.get(target) ? "---------------C------" : "----------------------"} ${target}\n`,
            "",
          );
        } else if (file === "cp") {
          const source = command.at(-2) ?? "";
          const matches =
            Boolean(attributes.get(source)) === Boolean(attributes.get(NodePath.dirname(target)));
          if (!options.clone || !matches) finish(new Error("Cannot reflink"), "", "");
          else if (command[0] === "--reflink=always") finish(null, "", "");
          else
            NodeFSP.copyFile(source, target).then(
              () => finish(null, "", ""),
              (error: Error) => finish(error, "", ""),
            );
        } else {
          finish(new Error("Unsupported fixture command"), "", "");
        }
      });
      return child;
    });
    yield* Effect.promise(() => NodeFSP.mkdir(NodePath.join(root, "runtime")));
    yield* use({ root, paths, attributes, commands, options, deadline }).pipe(
      Effect.provideService(Config.ServerConfig, paths),
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    Effect.provideService(HostProcess.Platform, "linux"),
  );

function seedDatabase(database: NodeSqlite.DatabaseSync) {
  database.exec(
    "PRAGMA journal_mode = WAL; CREATE TABLE fixture (value); INSERT INTO fixture VALUES (42);",
  );
}

function createDatabase(file: string) {
  using database = new NodeSqlite.DatabaseSync(file);
  seedDatabase(database);
}

const launchBackup = (root: string, dbPath: string) =>
  backupDatabase(
    root,
    { id: "trial", fromVersion: "1.0.0", targetVersion: "1.1.0", status: "pending", dbPath },
    new AbortController().signal,
  );

it.effect("sets No_COW on the private directory before SQLite creates the database", () =>
  fixture(({ paths, attributes, commands }) =>
    Effect.gen(function* () {
      yield* initializeV2Database(paths.dbPath);
      createDatabase(paths.dbPath);
      expect(commands.find(({ file }) => file === "chattr")).toMatchObject({
        args: ["+C", paths.stateDir],
        existingSqliteFiles: [],
        killSignal: "SIGKILL",
      });
      expect(attributes.get(paths.stateDir)).toBe(true);
      expect((yield* Effect.promise(() => NodeFSP.stat(paths.stateDir))).mode & 0o777).toBe(0o700);
    }),
  ),
);

it.effect.each([
  "non-btrfs",
  "existing database",
  "dangling database",
  "existing WAL",
  "non-private directory",
  "existing V1 database",
] as const)("skips No_COW for %s", (scenario) =>
  fixture(({ root, paths, commands, options }) =>
    Effect.gen(function* () {
      if (scenario === "non-btrfs") options.btrfs = false;
      if (scenario === "existing database") createDatabase(paths.dbPath);
      if (scenario === "dangling database")
        yield* Effect.promise(() => NodeFSP.symlink(NodePath.join(root, "missing"), paths.dbPath));
      if (scenario === "existing WAL")
        yield* Effect.promise(() => NodeFSP.writeFile(`${paths.dbPath}-wal`, "synthetic"));
      if (scenario === "existing V1 database")
        createDatabase(NodePath.join(paths.stateDir, "state.sqlite"));
      if (scenario === "non-private directory")
        yield* Effect.promise(() => NodeFSP.chmod(paths.stateDir, 0o750));
      const before = yield* Effect.promise(() =>
        NodeFSP.lstat(paths.dbPath).catch(() => undefined),
      );
      yield* initializeV2Database(paths.dbPath);
      expect(commands).toEqual([]);
      const after = yield* Effect.promise(() => NodeFSP.lstat(paths.dbPath).catch(() => undefined));
      if (scenario === "existing V1 database") expect(after?.isFile()).toBe(true);
      else {
        expect(after?.ino).toBe(before?.ino);
        expect(after?.mtimeMs).toBe(before?.mtimeMs);
      }
    }),
  ),
);

it.effect("skips a private directory outside the configured state path", () =>
  fixture(({ root, commands }) =>
    Effect.gen(function* () {
      const other = NodePath.join(root, "other");
      yield* Effect.promise(() => NodeFSP.mkdir(other, { mode: 0o700 }));
      yield* initializeV2Database(NodePath.join(other, "statev2.sqlite"));
      expect(commands).toEqual([]);
    }),
  ),
);

it.effect.each(["missing", "denied", "timeout"] as const)(
  "continues SQLite initialization when chattr is %s",
  (failure) =>
    fixture(({ paths, commands, attributes, options, deadline }) =>
      Effect.gen(function* () {
        options.tool = failure;
        using timer = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
        yield* initializeV2Database(paths.dbPath);
        createDatabase(paths.dbPath);
        expect(commands.filter(({ file }) => file === "chattr")).toHaveLength(1);
        expect(attributes.has(paths.stateDir)).toBe(false);
        expect(timer).toHaveBeenCalledWith(1500);
      }),
    ),
);

it.effect.each([true, false])("matches a new backup to source No_COW=%s", (noCow) =>
  fixture(({ root, paths, attributes, commands }) =>
    Effect.promise(async () => {
      createDatabase(paths.dbPath);
      attributes.set(paths.dbPath, noCow);
      const staging = NodePath.join(root, "runtime", "db-backup", "trial.staging");
      attributes.set(staging, !noCow);
      expect(await launchBackup(root, paths.dbPath)).toBeDefined();
      expect(commands.find(({ file }) => file === "chattr")?.args).toEqual([
        noCow ? "+C" : "-C",
        staging,
      ]);
      expect(commands.map(({ file }) => file)).toContain("cp");
      expect(await NodeFSP.readFile(NodePath.join(staging, "..", "trial", "database"))).toEqual(
        await NodeFSP.readFile(paths.dbPath),
      );
    }),
  ),
);

it.effect.each([
  "attribute denied",
  "ambiguous flags",
  "reflink unavailable",
  "matching attributes",
] as const)("uses the right free-space gate when %s", (scenario) =>
  fixture(({ root, paths, attributes, options }) =>
    Effect.promise(async () => {
      await NodeFSP.writeFile(paths.dbPath, "");
      const gib = 1024 ** 3;
      await NodeFSP.truncate(paths.dbPath, 2 * gib);
      attributes.set(paths.dbPath, true);
      if (scenario === "attribute denied") options.tool = "denied";
      if (scenario === "reflink unavailable") options.clone = false;
      if (scenario === "ambiguous flags") options.flagsReadable = false;
      const blocker = await databaseBackupBlocker(root, paths.dbPath, {
        readFreeBytes: async () => gib,
      });
      if (scenario === "matching attributes") expect(blocker).toBeUndefined();
      else expect(blocker).toContain("Not enough free disk space");
      expect(await NodeFSP.readdir(NodePath.join(root, "runtime", "db-backup"))).toEqual([]);
    }),
  ),
);

it.effect("makes a full backup copy when setting the destination attribute is denied", () =>
  fixture(({ root, paths, attributes, commands, options }) =>
    Effect.promise(async () => {
      createDatabase(paths.dbPath);
      attributes.set(paths.dbPath, true);
      options.tool = "denied";
      expect(await launchBackup(root, paths.dbPath)).toBeDefined();
      expect(commands.map(({ file }) => file)).not.toContain("cp");
      expect(
        await NodeFSP.readFile(NodePath.join(root, "runtime", "db-backup", "trial", "database")),
      ).toEqual(await NodeFSP.readFile(paths.dbPath));
    }),
  ),
);

it.effect("matches the backup attribute separately for SQLite, WAL and SHM", () =>
  fixture(({ root, paths, attributes, commands }) =>
    Effect.promise(async () => {
      using database = new NodeSqlite.DatabaseSync(paths.dbPath);
      seedDatabase(database);
      const sources = ["", "-wal", "-shm"].map((suffix) => `${paths.dbPath}${suffix}`);
      attributes.set(paths.dbPath, true);
      attributes.set(`${paths.dbPath}-shm`, true);
      const snapshot = await launchBackup(root, paths.dbPath);
      expect([...(snapshot?.files ?? [])]).toEqual(["", "-wal", "-shm"]);
      expect(commands.filter(({ file }) => file === "chattr").map(({ args }) => args[0])).toEqual([
        "+C",
        "-C",
        "+C",
      ]);
      expect(commands.filter(({ file }) => file === "cp").map(({ args }) => args.at(-2))).toEqual(
        sources,
      );
    }),
  ),
);
