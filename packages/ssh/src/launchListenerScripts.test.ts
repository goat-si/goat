// Shell doubles run synchronously; the Effect spawner adds nothing to these checks.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { REMOTE_LAUNCH_LISTENER_SCRIPT } from "./launchListenerScripts.ts";
import { REMOTE_HOST_PROCESS_SCRIPT } from "./runtimeOwnershipScripts.ts";

describe("Windows launch listener wait", () => {
  // PowerShell answers as its loop would: 3 for a gone server (vanish: mid-wait), 0 for a listener
  // (late: after the deadline), 4 at its deadline, 1 for a failed start; hang never answers, and
  // stubborn also ignores TERM. tasklist lists the server while alive and not dies; tasklistHang
  // never answers and ignores TERM. The clock moves a second per read.
  const listenerStates = [
    "listening",
    "alive",
    "late",
    "vanish",
    "hang",
    "stubborn",
    "fail",
    "dies",
    "tasklistHang",
  ] as const;
  const makeListenerHarness = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-windows-listener-" });
    const bin = `${root}/bin`;
    yield* fs.makeDirectory(bin);
    yield* fs.makeDirectory(`${root}/state`);
    for (const [name, body] of Object.entries({
      uname: "echo MINGW64_NT-10.0-26200",
      "powershell.exe": String.raw`echo "${"${"}GOAT_WAIT_UNTIL_MS:-poll}" >>"$TEST_ROOT/powershell-calls"
[ -n "${"${"}GOAT_WAIT_UNTIL_MS:-}" ] || exit 1
if [ -e "$TEST_ROOT/hang" ]; then
  if [ -e "$TEST_ROOT/stubborn" ]; then trap '' TERM; fi
  echo "$$" >"$TEST_ROOT/powershell-pid"; exec /bin/sleep 600
fi
if [ -e "$TEST_ROOT/vanish" ]; then rm -f "$TEST_ROOT/alive"; fi
[ -e "$TEST_ROOT/alive" ] || exit 3
[ -e "$TEST_ROOT/fail" ] && exit 1
[ -e "$TEST_ROOT/listening" ] || exit 4
if [ -e "$TEST_ROOT/late" ]; then echo 2000 >"$TEST_ROOT/clock"; fi
exit 0`,
      "tasklist.exe": String.raw`echo "$*" >>"$TEST_ROOT/tasklist-calls"
if [ -e "$TEST_ROOT/tasklistHang" ]; then trap '' TERM; echo "$$" >"$TEST_ROOT/tasklist-pid"; exec /bin/sleep 600; fi
if [ -e "$TEST_ROOT/alive" ] && [ ! -e "$TEST_ROOT/dies" ]; then echo '"goat.exe","4242","Services","0","1 K"'; fi`,
      // In the failure path (probing) the clock moves only once a hanging tasklist has started, so no
      // tasklist's 5 s run out before a slow host has started or answered it.
      date: [
        'if [ -e "$TEST_ROOT/probing" ] && { [ ! -e "$TEST_ROOT/tasklistHang" ] || [ ! -s "$TEST_ROOT/tasklist-pid" ]; }; then',
        '  cat "$TEST_ROOT/clock"; exit 0',
        "fi",
        'n="$(cat "$TEST_ROOT/clock")"; echo "$((n + 1))" >"$TEST_ROOT/clock"; echo "$n"',
      ].join("\n"),
      sleep: ":",
    })) {
      yield* fs.writeFileString(`${bin}/${name}`, `#!/bin/sh\n${body}\n`);
      yield* fs.chmod(`${bin}/${name}`, 0o755);
    }
    const lines = (name: string) =>
      fs
        .readFileString(`${root}/${name}`)
        .pipe(Effect.map((text) => text.trim().split("\n").filter(Boolean)));
    // Runs the wait, prints its status and the clock, then runs `after`.
    const run = (
      state: Partial<Record<(typeof listenerStates)[number], boolean>>,
      after: ReadonlyArray<string> = [],
    ) =>
      Effect.gen(function* () {
        for (const name of listenerStates) {
          if (state[name]) yield* fs.writeFileString(`${root}/${name}`, "");
          else yield* fs.remove(`${root}/${name}`, { force: true });
        }
        yield* fs.writeFileString(`${root}/clock`, "1000\n");
        yield* fs.writeFileString(`${root}/powershell-calls`, "");
        yield* fs.writeFileString(`${root}/tasklist-calls`, "");
        for (const name of ["probing", "tasklist-pid", "powershell-pid"])
          yield* fs.remove(`${root}/${name}`, { force: true });
        // Git Bash's sh is bash, whose job list the wait reads.
        const result = NodeChildProcess.spawnSync(
          "bash",
          [
            "-c",
            [
              REMOTE_HOST_PROCESS_SCRIPT,
              REMOTE_LAUNCH_LISTENER_SCRIPT.replaceAll("@@GOAT_READY_TIMEOUT_MS@@", "60000"),
              'REMOTE_PID=4242; REMOTE_PORT=3773; STATE_DIR="$TEST_ROOT/state"',
              'wait_launched_listener; echo "$?"; cat "$TEST_ROOT/clock"; : >"$TEST_ROOT/probing"',
              ...after,
            ].join("\n"),
          ],
          {
            encoding: "utf8",
            env: { ...process.env, TEST_ROOT: root, PATH: `${bin}:${process.env.PATH ?? ""}` },
          },
        );
        assert.equal(result.status, 0, result.stderr);
        const [status = "", clock = "", ...out] = result.stdout.trim().split("\n");
        return {
          status,
          clock: Number(clock),
          out,
          calls: yield* lines("powershell-calls"),
          tasklist: yield* lines("tasklist-calls"),
        };
      });
    const pid = (name: string) =>
      fs.readFileString(`${root}/${name}`).pipe(Effect.map((text) => Number(text.trim())));
    return { run, pid, state: `${root}/state`, fs };
  });

  it.effect(
    "waits for a launched server's listener inside one PowerShell start, held to the deadline",
    () =>
      Effect.gen(function* () {
        const { run, pid } = yield* makeListenerHarness;
        const wait = (state: Parameters<typeof run>[0]) =>
          run(state).pipe(
            Effect.map(({ status, calls, tasklist }) => {
              // The wait never runs tasklist, which can stall past the deadline.
              assert.deepEqual(tasklist, []);
              return { status, calls };
            }),
          );
        // One start waits until the launch's own deadline (1060 s, in ms); its answer is rechecked
        // against the clock only.
        assert.deepEqual(yield* wait({ listening: true, alive: true }), {
          status: "0",
          calls: ["1060000"],
        });
        // PowerShell's own deadline, and an answer after the shell's deadline, are not ready.
        assert.deepEqual(yield* wait({ alive: true }), { status: "1", calls: ["1060000"] });
        assert.deepEqual(yield* wait({ listening: true, alive: true, late: true }), {
          status: "1",
          calls: ["1060000"],
        });
        // A server that is gone, at the start or mid-wait, is reported as exited, not as a timeout.
        assert.deepEqual(yield* wait({ listening: true }), { status: "2", calls: ["1060000"] });
        assert.deepEqual(yield* wait({ listening: true, alive: true, vanish: true }), {
          status: "2",
          calls: ["1060000"],
        });
        // A failed start is tried again until the deadline.
        const failing = yield* wait({ alive: true, fail: true });
        assert.equal(failing.status, "1");
        assert.isAtLeast(failing.calls.length, 2);
        assert.deepEqual([...new Set(failing.calls)], ["1060000"]);
        // A PowerShell that never answers, beside a tasklist that would hang, is ended at the deadline
        // and collected.
        assert.deepEqual(yield* wait({ alive: true, hang: true, tasklistHang: true }), {
          status: "1",
          calls: ["1060000"],
        });
        const hung = yield* pid("powershell-pid");
        assert.throws(() => process.kill(hung, 0));
        // One that also ignores TERM is killed: the clock passes the deadline (1060) only by the
        // 2 s that TERM gets and the reads that check it.
        const stubborn = yield* run({ alive: true, hang: true, stubborn: true });
        assert.equal(stubborn.status, "1");
        assert.isAtMost(stubborn.clock, 1060 + 4);
        const killed = yield* pid("powershell-pid");
        assert.throws(() => process.kill(killed, 0));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("a failed launch's server checks after the listener wait cannot hang on tasklist", () =>
    Effect.gen(function* () {
      const { run, pid, state, fs } = yield* makeListenerHarness;
      // The failure path checks the server twice, then waits for it to exit.
      const failurePath = [
        'for check in 1 2; do if launch_server_alive "$REMOTE_PID"; then echo alive; else echo gone; fi; done',
        'launch_wait_exit "$REMOTE_PID"; cat "$TEST_ROOT/clock"',
      ];
      // A tasklist that never answers and ignores TERM runs once, is killed, and counts as alive:
      // 5 s for tasklist, 2 s for TERM and up to 3 s of exit wait, plus the reads that check them.
      const stalled = yield* run({ alive: true, tasklistHang: true }, failurePath);
      assert.equal(stalled.status, "1");
      assert.deepEqual(stalled.out.slice(0, 2), ["alive", "alive"]);
      assert.isAtMost(Number(stalled.out[2]) - stalled.clock, 5 + 2 + 3 + 3);
      assert.lengthOf(stalled.tasklist, 1);
      const stalledPid = yield* pid("tasklist-pid");
      assert.throws(() => process.kill(stalledPid, 0));
      assert.deepEqual(yield* fs.readDirectory(state), []);
      // PowerShell's word that the server is gone stands without tasklist.
      const gone = yield* run({ tasklistHang: true }, failurePath);
      assert.deepEqual([gone.status, ...gone.out.slice(0, 2)], ["2", "gone", "gone"]);
      assert.deepEqual(gone.tasklist, []);
      // A tasklist that answers is read as before.
      const answered = yield* run({ alive: true }, failurePath);
      assert.deepEqual(answered.out.slice(0, 2), ["alive", "alive"]);
      const died = yield* run({ alive: true, dies: true }, failurePath);
      assert.deepEqual(died.out.slice(0, 2), ["gone", "gone"]);
      assert.deepEqual(yield* fs.readDirectory(state), []);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
