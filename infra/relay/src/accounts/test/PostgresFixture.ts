// @effect-diagnostics nodeBuiltinImport:off -- Synchronous local PostgreSQL test process boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export function postgresBinaries() {
  try {
    const bin =
      process.env.PG_BIN ??
      NodeChildProcess.execFileSync("pg_config", ["--bindir"], { encoding: "utf8" }).trim();
    for (const name of ["initdb", "postgres", "pg_ctl", "psql"])
      NodeChildProcess.execFileSync(NodePath.join(bin, name), ["--version"], { stdio: "pipe" });
    return bin;
  } catch {
    throw new Error(
      "Relay PostgreSQL tests require initdb, postgres, pg_ctl and psql. Install PostgreSQL and expose pg_config or set test-only PG_BIN. Self-hosted runners must pre-provision these binaries.",
    );
  }
}

export function createPostgresFixture() {
  const bin = postgresBinaries();
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "relay-pg-"));
  const data = NodePath.join(root, "data");
  const socket = NodePath.join(root, "socket");
  NodeFS.mkdirSync(socket);
  const run = (name: string, args: ReadonlyArray<string>) => {
    const result = NodeChildProcess.spawnSync(NodePath.join(bin, name), [...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0)
      throw new Error(`Isolated PostgreSQL ${name} failed: ${result.stderr}`);
    return result.stdout;
  };
  let started = false;
  try {
    run("initdb", [
      "-D",
      data,
      "-A",
      "trust",
      "-U",
      "relay_test",
      "--no-locale",
      "--encoding=UTF8",
    ]);
    run("pg_ctl", [
      "-D",
      data,
      "-l",
      NodePath.join(root, "postgres.log"),
      "-o",
      `-k ${socket} -c listen_addresses='' -c max_connections=20`,
      "-w",
      "start",
    ]);
    started = true;
    const query = (sql: string) =>
      run("psql", [
        "-h",
        socket,
        "-U",
        "relay_test",
        "-d",
        "postgres",
        "-X",
        "-v",
        "ON_ERROR_STOP=1",
        "-At",
        "-c",
        sql,
      ]);
    return {
      bin,
      socket,
      query,
      migrate: (through?: string, after?: string) => {
        const dir = NodePath.resolve(import.meta.dirname, "../../../migrations/postgres");
        for (const name of NodeFS.readdirSync(dir).sort()) {
          if (through && name > through) break;
          if (after && name <= after) continue;
          query(
            `BEGIN;\n${NodeFS.readFileSync(NodePath.join(dir, name, "migration.sql"), "utf8")}\nCOMMIT;`,
          );
        }
      },
      [Symbol.dispose]() {
        try {
          run("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]);
        } finally {
          NodeFS.rmSync(root, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    if (started) run("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]);
    NodeFS.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
