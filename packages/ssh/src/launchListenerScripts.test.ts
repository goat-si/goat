// Shell doubles run synchronously; the Effect spawner adds nothing to these checks.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { REMOTE_LAUNCH_LISTENER_SCRIPT } from "./launchListenerScripts.ts";
import { REMOTE_HOST_PROCESS_SCRIPT } from "./runtimeOwnershipScripts.ts";
import { buildRemoteLaunchScript } from "./tunnel.ts";

// The launch's own failure branch and its wait_ready, as the launch script runs them.
const launch = buildRemoteLaunchScript({ archiveVersion: "1.2.3" });
const slice = (from: string, to: string) => {
  const start = launch.indexOf(from);
  const end = launch.indexOf(to, start);
  assert.isAtLeast(start, 0, from);
  assert.isAbove(end, start, to);
  return launch.slice(start, end + to.length);
};
const WAIT_READY = slice("wait_ready() {", "\nNODE\n}\n");
const FAILURE_BRANCH = slice("  if ! wait_launched_listener", "\n    exit 1\n  fi\n");
// The harness's bash: 4+ lists and waits through a FIFO, older bash keeps tr and sleep.
const bashMajor = Number(
  NodeChildProcess.spawnSync("bash", ["-c", "echo $BASH_VERSINFO"], { encoding: "utf8" }).stdout,
);

describe("Windows launch listener wait", () => {
  // PowerShell answers as its loop would: 3 for a gone server (vanish: mid-wait), 0 for a listener
  // (late: after the deadline), 4 at its deadline, 1 for a failed start; hang never answers, and
  // stubborn also ignores TERM. tasklist lists the server while alive; taskkill ends it, and the
  // *Hang states never answer and ignore TERM. The clock moves a second per read.
  const states = [
    "listening",
    "alive",
    "late",
    "vanish",
    "hang",
    "stubborn",
    "fail",
    "ready",
    "tasklistHang",
    "taskkillHang",
    "tasklistFails",
    "noFifo",
    "termAfterFifo",
    "owns",
    "netstatHang",
  ] as const;
  // Every Windows stand-in logs whether it ran as the bounded job, then its arguments.
  const record = (name: string) =>
    `echo "$GOAT_TEST_BOUNDED ${name} $*" >>"$TEST_ROOT/windows-calls"`;
  // Each start of a command the bounded runner could run per pass is logged; the real one runs.
  const counted = (name: string) =>
    `echo ${name} >>"$TEST_ROOT/forks"; PATH="$TEST_REAL_PATH" exec ${name} "$@"`;
  const hangs = (name: string) =>
    'if [ -e "$TEST_ROOT/' +
    name +
    'Hang" ]; then trap \'\' TERM; echo "$$" >"$TEST_ROOT/' +
    name +
    '-pid"; exec /bin/sleep 600; fi';
  const makeHarness = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-windows-listener-" });
    const bin = root + "/bin";
    yield* fs.makeDirectory(bin);
    yield* fs.makeDirectory(root + "/state");
    for (const [name, body] of Object.entries({
      uname: "echo MINGW64_NT-10.0-26200",
      "powershell.exe": [
        record("powershell"),
        // Without a deadline it is the one-shot listener check, which finds one only when owns is set.
        'if [ -z "$GOAT_WAIT_UNTIL_MS" ]; then [ -e "$TEST_ROOT/owns" ]; exit; fi',
        'if [ -e "$TEST_ROOT/hang" ]; then',
        "  if [ -e \"$TEST_ROOT/stubborn\" ]; then trap '' TERM; fi",
        '  echo "$$" >"$TEST_ROOT/powershell-pid"; exec /bin/sleep 600',
        "fi",
        '[ -z "$TEST_LAUNCH" ] || { cp "$TEST_ROOT/clock" "$TEST_ROOT/clock-at-probe"; : >"$TEST_ROOT/probing"; }',
        'if [ -e "$TEST_ROOT/vanish" ]; then rm -f "$TEST_ROOT/alive"; fi',
        '[ -e "$TEST_ROOT/alive" ] || exit 3',
        '[ -e "$TEST_ROOT/fail" ] && exit 1',
        '[ -e "$TEST_ROOT/listening" ] || exit 4',
        'if [ -e "$TEST_ROOT/late" ]; then : >"$TEST_ROOT/late-fired"; fi',
        "exit 0",
      ].join("\n"),
      "tasklist.exe": [
        record("tasklist"),
        // A recorded answer, byte for byte, when a test gives one.
        'if [ -e "$TEST_ROOT/tasklist-out" ]; then cat "$TEST_ROOT/tasklist-out"; exit 0; fi',
        hangs("tasklist"),
        '[ ! -e "$TEST_ROOT/tasklistFails" ] || exit 1',
        'if [ -e "$TEST_ROOT/alive" ]; then echo \'"goat.exe","4242","Services","0","1 K"\'',
        "else echo 'INFO: No tasks are running which match the specified criteria.'; fi",
      ].join("\n"),
      // It ends the server even when it then hangs, so only its own timeout says the stop is unknown.
      "taskkill.exe": [record("taskkill"), 'rm -f "$TEST_ROOT/alive"', hangs("taskkill")].join(
        "\n",
      ),
      // Prints netstat-out byte for byte, then may stall, then exits with netstat-status.
      "netstat.exe": [
        record("netstat"),
        '[ ! -e "$TEST_ROOT/netstat-out" ] || cat "$TEST_ROOT/netstat-out"',
        hangs("netstat"),
        'exit "$(cat "$TEST_ROOT/netstat-status" 2>/dev/null || echo 0)"',
      ].join("\n"),
      runner: [record("runner"), '[ -e "$TEST_ROOT/ready" ]'].join("\n"),
      // Once the launch's failure path starts (probing) the clock moves only while a hanging
      // stand-in runs, so no bound can run out before a slow host has started or answered one.
      date: [
        'echo date >>"$TEST_ROOT/forks"',
        // A late listener moves the clock past the deadline; a marker, so no read races its write.
        '[ ! -e "$TEST_ROOT/late-fired" ] || { echo 2000; exit 0; }',
        'if [ -e "$TEST_ROOT/probing" ] &&',
        '  ! { [ -e "$TEST_ROOT/tasklistHang" ] && [ -s "$TEST_ROOT/tasklist-pid" ]; } &&',
        '  ! { [ -e "$TEST_ROOT/taskkillHang" ] && [ -s "$TEST_ROOT/taskkill-pid" ]; } &&',
        '  ! { [ -e "$TEST_ROOT/netstatHang" ] && [ -s "$TEST_ROOT/netstat-pid" ]; }; then',
        '  cat "$TEST_ROOT/clock"; exit 0',
        "fi",
        'n="$(cat "$TEST_ROOT/clock")"; echo "$((n + 1))" >"$TEST_ROOT/clock"; echo "$n"',
      ].join("\n"),
      sleep: 'echo sleep >>"$TEST_ROOT/forks"',
      tr: counted("tr"),
      rm: counted("rm"),
      // termAfterFifo: the shell dies of TERM once its FIFO exists, before it removes the name.
      mkfifo: [
        '[ ! -e "$TEST_ROOT/noFifo" ] || exit 1',
        'echo mkfifo >>"$TEST_ROOT/forks"',
        'PATH="$TEST_REAL_PATH" mkfifo "$@" || exit',
        '[ ! -e "$TEST_ROOT/termAfterFifo" ] || kill -TERM "$PPID"',
      ].join("\n"),
      // A command that ends at once, and one that ends once the test opens release for writing.
      quick: [record("quick"), "exit 7"].join("\n"),
      slow: [record("slow"), 'exec /bin/cat "$TEST_ROOT/release" >/dev/null'].join("\n"),
    })) {
      yield* fs.writeFileString(bin + "/" + name, "#!/bin/sh\n" + body + "\n");
      yield* fs.chmod(bin + "/" + name, 0o755);
    }
    const lines = (name: string) =>
      fs
        .readFileString(root + "/" + name)
        .pipe(Effect.map((text) => text.trim().split("\n").filter(Boolean)));
    // Runs body after the scripts, with the bounded job marking the commands it runs. Unless
    // production, the clock is date's, so it moves a second per read, and a pause returns at once.
    const run = (
      state: Partial<Record<(typeof states)[number], boolean>>,
      body: string,
      launching = false,
      production = false,
    ) =>
      Effect.gen(function* () {
        for (const name of states) {
          if (state[name]) yield* fs.writeFileString(root + "/" + name, "");
          else yield* fs.remove(root + "/" + name, { force: true });
        }
        yield* fs.writeFileString(root + "/clock", "1000\n");
        yield* fs.writeFileString(root + "/windows-calls", "");
        yield* fs.writeFileString(root + "/forks", "");
        yield* fs.writeFileString(root + "/state/server.log", "listen failed\n");
        for (const name of [
          "probing",
          "clock-at-probe",
          "tasklist-pid",
          "taskkill-pid",
          "powershell-pid",
          "netstat-pid",
          "late-fired",
          "end",
        ])
          yield* fs.remove(root + "/" + name, { force: true });
        // Git Bash's sh is bash, whose job list the bounded runner reads.
        const result = NodeChildProcess.spawnSync(
          "bash",
          [
            "--posix",
            "-c",
            [
              // As in the launch script, which Git Bash runs as sh: POSIX mode, set -eu.
              "set -eu",
              REMOTE_HOST_PROCESS_SCRIPT,
              REMOTE_LAUNCH_LISTENER_SCRIPT.replaceAll("@@GOAT_READY_TIMEOUT_MS@@", "60000"),
              "launch_bounded_job() { GOAT_TEST_BOUNDED=1 MSYS2_ARG_CONV_EXCL='*' exec \"$@\"; }",
              production
                ? ""
                : "launch_now() { launch_now_us=$(( $(date +%s) * 1000000 )); }; launch_pause() { :; }",
              'REMOTE_PID=4242; REMOTE_PORT=3773; STATE_DIR="$TEST_ROOT/state"',
              body,
            ].join("\n"),
          ],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              TEST_ROOT: root,
              TEST_LAUNCH: launching ? "1" : "",
              TEST_REAL_PATH: process.env.PATH ?? "",
              PATH: bin + ":" + (process.env.PATH ?? ""),
            },
          },
        );
        return {
          code: result.status,
          stdout: result.stdout.trim(),
          stderr: result.stderr,
          calls: yield* lines("windows-calls"),
          forks: yield* lines("forks"),
        };
      });
    const pid = (name: string) =>
      fs.readFileString(root + "/" + name).pipe(Effect.map((text) => Number(text.trim())));
    const clockAt = (name: string) =>
      fs.readFileString(root + "/" + name).pipe(Effect.map((text) => Number(text.trim())));
    return { run, pid, clockAt, root, fs };
  });

  it.effect(
    "waits for a launched server's listener inside one PowerShell start, held to the deadline",
    () =>
      Effect.gen(function* () {
        const { run, pid } = yield* makeHarness;
        const wait = (state: Parameters<typeof run>[0]) =>
          run(
            state,
            'if wait_launched_listener; then s=0; else s=$?; fi; echo "$s"; cat "$TEST_ROOT/clock"',
          ).pipe(
            Effect.map(({ code, stdout, stderr, calls }) => {
              assert.equal(code, 0, stderr);
              const [status = "", clock = ""] = stdout.split("\n");
              // Only PowerShell runs, and only as the bounded job.
              for (const call of calls) assert.match(call, /^1 powershell /);
              return { status, clock: Number(clock), starts: calls.length };
            }),
          );
        assert.deepInclude(yield* wait({ listening: true, alive: true }), {
          status: "0",
          starts: 1,
        });
        // PowerShell's own deadline, and an answer after the shell's deadline, are not ready.
        assert.deepInclude(yield* wait({ alive: true }), { status: "1", starts: 1 });
        assert.deepInclude(yield* wait({ listening: true, alive: true, late: true }), {
          status: "1",
          starts: 1,
        });
        // A server that is gone, at the start or mid-wait, is reported as exited, not as a timeout.
        assert.deepInclude(yield* wait({ listening: true }), { status: "2", starts: 1 });
        assert.deepInclude(yield* wait({ listening: true, alive: true, vanish: true }), {
          status: "2",
          starts: 1,
        });
        // A failed start is tried again until the deadline.
        const failing = yield* wait({ alive: true, fail: true });
        assert.equal(failing.status, "1");
        assert.isAtLeast(failing.starts, 2);
        // A PowerShell that never answers is ended at the deadline and collected; one that also
        // ignores TERM is killed, the clock passing the deadline (1060) only by the 2 s TERM gets
        // and the reads that check it.
        assert.deepInclude(yield* wait({ alive: true, hang: true }), { status: "1", starts: 1 });
        const hung = yield* pid("powershell-pid");
        assert.throws(() => process.kill(hung, 0));
        const stubborn = yield* wait({ alive: true, hang: true, stubborn: true });
        assert.equal(stubborn.status, "1");
        assert.isAtMost(stubborn.clock, 1060 + 5);
        const killed = yield* pid("powershell-pid");
        assert.throws(() => process.kill(killed, 0));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("a bounded command starts no tr, date or sleep in any pass, however long it runs", () =>
    Effect.gen(function* () {
      const { run, root, fs } = yield* makeHarness;
      NodeChildProcess.execFileSync("mkfifo", [root + "/release"]);
      const result = yield* run(
        {},
        [
          // The production pause, which opens release on its third call and so ends slow.
          "eval \"$(declare -f launch_pause | sed '1s/^launch_pause/launch_pause_real/')\"",
          'launch_pause() { test_pauses=$((test_pauses + 1)); [ "$test_pauses" != 3 ] || : >"$TEST_ROOT/release"; launch_pause_real "$1"; }',
          'test_pauses=0; if launch_bounded 30 quick; then echo 0; else echo "$?"; fi',
          'echo mark >>"$TEST_ROOT/forks"',
          'if launch_bounded 30 quick; then echo 0; else echo "$?"; fi',
          "test_pauses=0",
          'if launch_bounded 30 slow; then echo 0; else echo "$?"; fi',
          'echo "$test_pauses"',
        ].join("\n"),
        false,
        true,
      );
      assert.equal(result.code, 0, result.stderr);
      // On bash 4+ the FIFO is made once per script and its name removed, and no pass starts
      // anything. Older bash takes the clock from one date per script and lists with tr and sleeps.
      if (bashMajor >= 4) {
        assert.deepEqual(result.forks, ["mkfifo", "rm", "mark"]);
      } else {
        assert.equal(result.forks.filter((name) => name === "date").length, 1);
        assert.includeMembers(["tr", "sleep", "date", "mark"], result.forks);
      }
      const [quick, again, slow, pauses = ""] = result.stdout.split("\n");
      assert.deepEqual([quick, again, slow], ["7", "7", "0"]);
      assert.isAtLeast(Number(pauses), 3);
      assert.deepEqual(
        result.calls.map((call) => call.trim()),
        ["1 quick", "1 quick", "1 slow"],
      );
      assert.deepEqual(yield* fs.readDirectory(root + "/state"), ["server.log"]);
      // Without a FIFO the job list comes from tr, and the command still answers with its status.
      const fallback = yield* run(
        { noFifo: true },
        'if launch_bounded 30 quick; then echo 0; else echo "$?"; fi',
        false,
        true,
      );
      assert.equal(fallback.stdout, "7", fallback.stderr);
      assert.include(fallback.forks, "tr");
      assert.notInclude(fallback.forks, "mkfifo");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("a FIFO name a killed launch left is removed by the next, a live script's never", () =>
    Effect.gen(function* () {
      const { run, root, fs } = yield* makeHarness;
      const fifos = () =>
        fs
          .readDirectory(root + "/state")
          .pipe(Effect.map((names) => names.filter((name) => name.startsWith("launch-tick."))));
      const killed = yield* run({ termAfterFifo: true }, "launch_bounded 30 quick", false, true);
      // bash before 4 makes no FIFO, so nothing ends it early and it has none to leave.
      assert.equal(killed.code, bashMajor >= 4 ? null : 7);
      assert.lengthOf(yield* fifos(), bashMajor >= 4 ? 1 : 0);
      // This test's own process is alive, so a FIFO named for it is a live script's.
      const live = "launch-tick." + process.pid;
      NodeChildProcess.execFileSync("mkfifo", [root + "/state/" + live]);
      const next = yield* run(
        {},
        'if launch_bounded 30 quick; then echo 0; else echo "$?"; fi',
        false,
        true,
      );
      assert.equal(next.stdout, "7", next.stderr);
      assert.deepEqual(yield* fifos(), [live]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("reads tasklist as gone only from its one-line localized no-match answer", () =>
    Effect.gen(function* () {
      const { run, root, fs } = yield* makeHarness;
      const answer = (bytes: Uint8Array) =>
        Effect.gen(function* () {
          yield* fs.writeFile(root + "/tasklist-out", bytes);
          const result = yield* run(
            { alive: true },
            // probing holds the clock, so only a stall could reach tasklist's bound.
            ': >"$TEST_ROOT/probing"; if launch_server_alive "$REMOTE_PID"; then echo alive; else echo gone; fi',
          );
          yield* fs.remove(root + "/tasklist-out");
          assert.equal(result.code, 0, result.stderr);
          return result.stdout;
        });
      const text = (value: string) => new TextEncoder().encode(value);
      const info = "INFO: No tasks are running which match the specified criteria.\r\n";
      assert.equal(yield* answer(text(info)), "gone");
      // Korean Windows answers in CP949, as measured on a Git Bash host.
      const korean =
        "c1a4bab83a20bdc7c7e020c1dfc0ce20c0dbbef720c1df20c1f6c1a4b5c820c1b6b0c7bfa120c0cfc4a1c7cfb4c220c0dbbef7c0cc20bef8bdc0b4cfb4d92e0d0a";
      assert.equal(yield* answer(Buffer.from(korean, "hex")), "gone");
      assert.equal(yield* answer(text("unexpected output\r\n")), "alive");
      assert.equal(yield* answer(text('"goat.exe","4242","Services","0","1 K"\r\n')), "alive");
      assert.equal(yield* answer(text(info + info)), "alive");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  // The one-shot ownership check after readiness, as server_owns_listener runs it: netstat's
  // output (bytes), its exit status and whether it stalls; PowerShell's answer is owns.
  const ownership = (
    harness: Effect.Success<typeof makeHarness>,
    output: string | Uint8Array,
    options: { pid?: number; port?: number; status?: number; hang?: boolean; owns?: boolean } = {},
  ) =>
    Effect.gen(function* () {
      const { run, root, fs } = harness;
      yield* fs.writeFile(
        root + "/netstat-out",
        typeof output === "string" ? new TextEncoder().encode(output) : output,
      );
      yield* fs.writeFileString(root + "/netstat-status", String(options.status ?? 0));
      const result = yield* run(
        { netstatHang: options.hang ?? false, owns: options.owns ?? false },
        [
          // probing holds the clock, so only the stalled netstat reaches its bound.
          ': >"$TEST_ROOT/probing"',
          "REMOTE_PID=" + (options.pid ?? 1234) + "; REMOTE_PORT=" + (options.port ?? 3773),
          'if server_owns_listener "$REMOTE_PID" "$REMOTE_PORT"; then echo 0; else echo "$?"; fi',
        ].join("\n"),
      );
      assert.equal(result.code, 0, result.stderr);
      // Both run as the bounded job; netstat with its documented arguments.
      for (const call of result.calls) assert.match(call, /^1 (netstat -ano -p TCP|powershell )/);
      return { status: result.stdout, commands: result.calls.map((call) => call.split(" ")[1]) };
    });
  const HEADER =
    "\r\nActive Connections\r\n\r\n  Proto  Local Address          Foreign Address        State           PID\r\n";
  const row = (local: string, foreign: string, state: string, pid: string, end = "\r\n") =>
    "  TCP    " + local.padEnd(23) + foreign.padEnd(23) + state.padEnd(16) + pid + end;
  const LISTENING = row("127.0.0.1:3773", "0.0.0.0:0", "LISTENING", "1234");
  // Recorded with netstat -ano -p TCP on a Korean Windows 11 host (CP949 header, CRLF lines),
  // with its non-loopback addresses mapped to documentation ranges and stored with LF endings.
  const korean = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const lf = yield* fs.readFile(import.meta.dirname + "/fixtures/netstat-ano-tcp-ko.txt");
    const crlf = Buffer.from(Buffer.from(lf).toString("latin1").replaceAll("\n", "\r\n"), "latin1");
    return { lf, crlf };
  });

  it.effect(
    "a LISTENING row for the server's port and PID proves ownership without PowerShell",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        const recorded = yield* korean;
        const owned = { status: "0", commands: ["netstat"] };
        // The recorded host's own listener: PID 12308 on 127.0.0.1:2640, among 238 lines.
        for (const output of [recorded.crlf, recorded.lf])
          assert.deepEqual(yield* ownership(harness, output, { pid: 12308, port: 2640 }), owned);
        assert.deepEqual(yield* ownership(harness, HEADER + LISTENING), owned);
        assert.deepEqual(
          yield* ownership(harness, HEADER + LISTENING.replace("\r\n", "\n")),
          owned,
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("netstat output that does not prove ownership leaves the answer to PowerShell", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const recorded = yield* korean;
      const rejected = {
        "the recorded output, for another server": [recorded.crlf, { pid: 4242, port: 3773 }],
        "another PID": [HEADER + row("127.0.0.1:3773", "0.0.0.0:0", "LISTENING", "4321")],
        "every interface": [HEADER + row("0.0.0.0:3773", "0.0.0.0:0", "LISTENING", "1234")],
        "IPv6 loopback": [HEADER + row("[::1]:3773", "[::]:0", "LISTENING", "1234")],
        "a connection": [HEADER + row("127.0.0.1:3773", "127.0.0.1:50000", "ESTABLISHED", "1234")],
        "ESTABLISHED to 0.0.0.0:0": [
          HEADER + row("127.0.0.1:3773", "0.0.0.0:0", "ESTABLISHED", "1234"),
        ],
        CLOSED: [HEADER + row("127.0.0.1:3773", "0.0.0.0:0", "CLOSED", "1234")],
        BOUND: [HEADER + row("127.0.0.1:3773", "0.0.0.0:0", "BOUND", "1234")],
        "a longer port": [HEADER + row("127.0.0.1:37730", "0.0.0.0:0", "LISTENING", "1234")],
        "a shorter port": [HEADER + row("127.0.0.1:377", "0.0.0.0:0", "LISTENING", "1234")],
        "a PID the server's is a prefix of": [HEADER + LISTENING, { pid: 123 }],
        "a PID that is a prefix of the server's": [
          HEADER + row("127.0.0.1:3773", "0.0.0.0:0", "LISTENING", "123"),
        ],
        "an extra field": [HEADER + row("127.0.0.1:3773", "0.0.0.0:0", "LISTENING", "1234 9")],
        "a final line with no newline": [HEADER + LISTENING.replace("\r\n", "")],
        "a final line cut before its CR": [HEADER + LISTENING.replace("\n", "")],
        "a second row for the same address": [
          HEADER + LISTENING + row("127.0.0.1:3773", "0.0.0.0:0", "LISTENING", "4321"),
        ],
      } as const;
      for (const [name, [output, options = {}]] of Object.entries(rejected)) {
        assert.deepEqual(
          yield* ownership(harness, output, options),
          { status: "1", commands: ["netstat", "powershell"] },
          name,
        );
      }
      // PowerShell's answer is the answer.
      assert.deepEqual(yield* ownership(harness, rejected["another PID"][0], { owns: true }), {
        status: "0",
        commands: ["netstat", "powershell"],
      });
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect(
    "netstat that fails, stalls or answers in another language falls back to PowerShell",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        const fallback = { status: "0", commands: ["netstat", "powershell"] };
        // German Windows prints ABHÖREN for LISTENING (CP850, Ö is 0x99).
        const german = Buffer.from(
          "\r\nAktive Verbindungen\r\n\r\n  Proto  Lokale Adresse         Remoteadresse          Status           PID\r\n" +
            row("127.0.0.1:3773", "0.0.0.0:0", "ABH\x99REN", "1234"),
          "latin1",
        );
        assert.deepEqual(yield* ownership(harness, german, { owns: true }), fallback);
        assert.deepEqual(yield* ownership(harness, "", { owns: true }), fallback);
        // A matching row from a netstat that then failed, or stalled and was ended at its bound.
        assert.deepEqual(
          yield* ownership(harness, HEADER + LISTENING, { status: 1, owns: true }),
          fallback,
        );
        assert.deepEqual(
          yield* ownership(harness, HEADER + LISTENING, { hang: true, owns: true }),
          fallback,
        );
        const stalled = yield* harness.pid("netstat-pid");
        assert.throws(() => process.kill(stalled, 0));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("a failed launch runs every Windows command bounded and never hangs on one", () =>
    Effect.gen(function* () {
      const { run, pid, clockAt, root, fs } = yield* makeHarness;
      const body = [
        WAIT_READY,
        'GOAT_ARCHIVE_MODE=1; RUNNER_FILE="$TEST_ROOT/bin/runner"; LAUNCH_ATTEMPTS=9; LAUNCH_LOG_OFFSET=0',
        'LOG_FILE="$STATE_DIR/server.log"; PID_FILE="$STATE_DIR/pid"; PORT_FILE="$STATE_DIR/port"',
        'MANAGED_FILE="$STATE_DIR/managed"; DATABASE_AHEAD_FILE="$STATE_DIR/ahead"; SELECTED_VERSION=1.2.3',
        "database_ahead_exit() { exit 9; }",
        'trap \'cat "$TEST_ROOT/clock" >"$TEST_ROOT/end"\' EXIT',
        "for launch_try in 1; do",
        FAILURE_BRANCH,
        "done",
      ].join("\n");
      const launchRun = (state: Parameters<typeof run>[0]) =>
        Effect.gen(function* () {
          const result = yield* run(state, body, true);
          assert.notInclude(result.stderr, "unbound variable");
          assert.equal(result.code, 1, result.stderr);
          assert.include(result.stderr, "did not become ready");
          // Every Windows command the launch ran after its listener wait started was the bounded job.
          assert.deepEqual(
            result.calls.filter((call) => !call.startsWith("1 ")),
            [],
          );
          const commands = result.calls.map((call) => call.split(" ")[1]);
          return {
            unconfirmed: result.stderr.includes(
              "could not confirm that the server (PID 4242) stopped",
            ),
            commands,
          };
        });
      // A taskkill that never answers and ignores TERM is killed at its bound, and the server is
      // reported as not confirmed stopped although tasklist no longer lists it. The clock's bound: 10 s
      // for taskkill and 2 s for TERM, 3 s of exit wait, two tasklist checks of at most 5 + 2 s, reads.
      const stalledKill = yield* launchRun({ alive: true, taskkillHang: true });
      assert.isTrue(stalledKill.unconfirmed);
      assert.equal(stalledKill.commands.filter((name) => name === "taskkill").length, 1);
      const killPid = yield* pid("taskkill-pid");
      assert.throws(() => process.kill(killPid, 0));
      assert.isAtMost(
        (yield* clockAt("end")) - (yield* clockAt("clock-at-probe")),
        10 + 2 + 3 + 2 * (5 + 2) + 4,
      );
      // A tasklist that never answers counts as alive, so the stop is not confirmed either.
      const stalledList = yield* launchRun({ alive: true, tasklistHang: true });
      assert.isTrue(stalledList.unconfirmed);
      assert.equal(stalledList.commands.filter((name) => name === "tasklist").length, 1);
      const listPid = yield* pid("tasklist-pid");
      assert.throws(() => process.kill(listPid, 0));
      // A tasklist that fails with no output is no answer: the server counts as alive, is stopped,
      // and is still reported as not confirmed stopped.
      const failedList = yield* launchRun({ alive: true, tasklistFails: true });
      assert.isTrue(failedList.unconfirmed);
      assert.include(failedList.commands, "taskkill");
      // PowerShell's word that the server is gone stands: no tasklist, no taskkill.
      const gone = yield* launchRun({});
      assert.isFalse(gone.unconfirmed);
      assert.deepEqual(gone.commands, ["powershell"]);
      // A ready server that does not own its listener is stopped, with each command bounded.
      const stopped = yield* launchRun({ listening: true, alive: true, ready: true });
      assert.isFalse(stopped.unconfirmed);
      assert.includeMembers(stopped.commands, [
        "powershell",
        "runner",
        "netstat",
        "tasklist",
        "taskkill",
      ]);
      assert.deepEqual(yield* fs.readDirectory(root + "/state"), ["server.log"]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
