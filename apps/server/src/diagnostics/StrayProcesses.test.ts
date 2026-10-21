// @effect-diagnostics nodeBuiltinImport:off - the cleanup test runs a real child process.
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as StrayProcesses from "./StrayProcesses.ts";
import {
  orphanedServer,
  parsePsRows,
  serveBaseDir,
  STRAY_TEMPORARY_HOME_MIN_AGE_MS,
  strayReason,
} from "./StrayProcesses.ts";

const LEAKED =
  "/Users/me/.nvm/versions/node/v24.20.0/bin/node /private/tmp/goat-test-7kyqAJ/goat-protocol-O2sFxR/dev's old entry.cjs serve --host 127.0.0.1 --port 54323 --base-dir /private/tmp/goat-test-7kyqAJ/goat-protocol-O2sFxR/.goat";
const SERVICE =
  "/Users/me/.goat/runtime/goat/versions/0.1.1-nightly.20261020.205/goat serve --host 127.0.0.1 --port 3773 --base-dir /Users/me/.goat";
const self = { pid: 32043, uid: 501, baseDir: "/Users/me/.goat" };

describe("parsePsRows", () => {
  it("reads pid, parent, owner, start time and the whole command line", () => {
    const rows = parsePsRows(
      [
        "72341     1   501 Sun Oct 19 08:20:11 2026     " + LEAKED,
        "  412   400   501 Tue Oct  7 09:01:02 2026 /bin/zsh -l",
        "garbage",
      ].join("\n"),
    );
    expect(rows).toEqual([
      {
        pid: 72341,
        ppid: 1,
        uid: 501,
        startedAtMs: Date.UTC(2026, 9, 19, 8, 20, 11),
        command: LEAKED,
      },
      {
        pid: 412,
        ppid: 400,
        uid: 501,
        startedAtMs: Date.UTC(2026, 9, 7, 9, 1, 2),
        command: "/bin/zsh -l",
      },
    ]);
  });
});

describe("serveBaseDir", () => {
  it("finds the home of a GOAT serve command, spaces and all", () => {
    expect(serveBaseDir(LEAKED)).toBe("/private/tmp/goat-test-7kyqAJ/goat-protocol-O2sFxR/.goat");
    expect(serveBaseDir("t3 serve --base-dir=/tmp/My Home --port 1")).toBe("/tmp/My Home");
  });

  it("ignores other programs and other GOAT subcommands", () => {
    expect(serveBaseDir("python -m http.server serve --base-dir /tmp/x")).toBeNull();
    expect(serveBaseDir("goat doctor --base-dir /tmp/x")).toBeNull();
    expect(serveBaseDir("goat serve --port 1")).toBeNull();
  });
});

describe("orphanedServer", () => {
  const row = { pid: 72341, ppid: 1, uid: 501, startedAtMs: 0, command: LEAKED };

  it("accepts this user's reparented GOAT server", () => {
    expect(orphanedServer(row, self)).toBe(
      "/private/tmp/goat-test-7kyqAJ/goat-protocol-O2sFxR/.goat",
    );
  });

  it("leaves servers something still owns, other users, and this server alone", () => {
    expect(orphanedServer({ ...row, ppid: 900 }, self)).toBeNull();
    expect(orphanedServer({ ...row, uid: 502 }, self)).toBeNull();
    expect(orphanedServer({ ...row, pid: self.pid }, self)).toBeNull();
    expect(orphanedServer({ ...row, command: SERVICE }, self)).toBeNull();
  });
});

describe("strayReason", () => {
  it("counts a server whose home is gone, at any age", () => {
    expect(strayReason({ homeExists: false, homeIsTemporary: false, ageMs: 0 })).toBe(
      "home_deleted",
    );
  });

  it("counts a temporary home only once a test run could not still be using it", () => {
    const old = STRAY_TEMPORARY_HOME_MIN_AGE_MS;
    expect(strayReason({ homeExists: true, homeIsTemporary: true, ageMs: old - 1 })).toBeNull();
    expect(strayReason({ homeExists: true, homeIsTemporary: true, ageMs: old })).toBe(
      "temporary_home",
    );
  });

  it("never counts a server with a real home, such as a launchd or systemd service", () => {
    expect(strayReason({ homeExists: true, homeIsTemporary: false, ageMs: 10 ** 10 })).toBeNull();
  });
});

// A real child process stands in for the leaked server; only `ps` is faked, so the signals,
// the exit checks and the result are the service's own.
it.live("stops a verified stray server and leaves a young test server running", () =>
  Effect.gen(function* () {
    const child = NodeChildProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], {
      stdio: "ignore",
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => child.kill("SIGKILL")));
    const pid = child.pid!;
    const uid = process.getuid!();
    const MONTHS = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    // ps's lstart, "Mon Oct 19 08:20:11 2026"; the parser ignores the weekday.
    const lstart = (ms: number) => {
      const iso = DateTime.formatIso(DateTime.makeUnsafe(ms));
      const day = iso.slice(8, 10).replace(/^0/, " ");
      return (
        "Mon " +
        MONTHS[Number(iso.slice(5, 7)) - 1] +
        " " +
        day +
        " " +
        iso.slice(11, 19) +
        " " +
        iso.slice(0, 4)
      );
    };
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1000) * 1000;
    const startedAt = now - 2 * 3_600_000;
    const missingHome = "/tmp/goat-stray-test-" + pid + "-gone/.goat";
    const fs = yield* FileSystem.FileSystem;
    const youngHome = yield* fs.makeTempDirectoryScoped({ prefix: "goat-stray-young-" });
    // Lazy, like the real runner: each poll lists the processes again.
    const run: ProcessRunner.ProcessRunner["Service"]["run"] = () =>
      Effect.sync(() => ({
        stdout: [
          ...(child.exitCode === null && child.signalCode === null
            ? [
                `${pid} 1 ${uid} ${lstart(startedAt)} node /tmp/goat-test-x/entry.cjs serve --base-dir ${missingHome}`,
              ]
            : []),
          `999999 1 ${uid} ${lstart(now)} goat serve --base-dir ${youngHome}`,
        ].join("\n"),
        stderr: "",
        code: 0 as never,
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      }));
    const strays = yield* StrayProcesses.StrayProcesses.pipe(
      Effect.provide(
        StrayProcesses.layer.pipe(
          Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, { run })),
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "stray-processes-" })),
        ),
      ),
    );
    const result = yield* strays.cleanUp;
    assert.deepEqual(
      { stopped: result.stopped, forced: result.forced, failed: result.failed },
      { stopped: 1, forced: 0, failed: [] },
    );
    assert.deepEqual(result.remaining.processes, []);
    assert.notEqual(child.signalCode ?? child.exitCode, null);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
