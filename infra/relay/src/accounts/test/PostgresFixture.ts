// @effect-diagnostics nodeBuiltinImport:off -- Synchronous local PostgreSQL test process boundary.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export function postgresBinaries() {
  try {
    const bin =
      process.env.PG_BIN ?? execFileSync("pg_config", ["--bindir"], { encoding: "utf8" }).trim();
    for (const name of ["initdb", "postgres", "pg_ctl", "psql"])
      execFileSync(join(bin, name), ["--version"], { stdio: "pipe" });
    return bin;
  } catch {
    throw new Error(
      "Relay PostgreSQL tests require initdb, postgres, pg_ctl and psql. Install PostgreSQL and expose pg_config or set test-only PG_BIN. Self-hosted runners must pre-provision these binaries.",
    );
  }
}

export function createPostgresFixture() {
  const bin = postgresBinaries();
  const root = mkdtempSync(join(tmpdir(), "relay-pg-"));
  const data = join(root, "data");
  const socket = join(root, "socket");
  mkdirSync(socket);
  const run = (name: string, args: ReadonlyArray<string>) => {
    const result = spawnSync(join(bin, name), [...args], {
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
      join(root, "postgres.log"),
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
        const dir = resolve(import.meta.dirname, "../../../migrations/postgres");
        for (const name of readdirSync(dir).sort()) {
          if (through && name > through) break;
          if (after && name <= after) continue;
          query(`BEGIN;\n${readFileSync(join(dir, name, "migration.sql"), "utf8")}\nCOMMIT;`);
        }
      },
      [Symbol.dispose]() {
        try {
          run("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    if (started) run("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]);
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
