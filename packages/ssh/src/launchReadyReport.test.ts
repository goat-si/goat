// @effect-diagnostics nodeBuiltinImport:off - runs the generated launch's ready step against a temporary home.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { it } from "@effect/vitest";
import { assert, describe } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { REMOTE_PROTOCOL_TOKEN_SCRIPT, REMOTE_RUNNER_HINT_SCRIPT } from "./runtimeFactsScripts.ts";
import { buildRemoteLaunchScript } from "./tunnel.ts";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const version = "1.2.3";
const LIVE = "live " + version + " 1 1 4242 4343";
const COMPAT = "compatible 1 inst-1";
const RECORD = JSON.stringify({ pid: 4242, port: 4343, instanceId: "inst-1" });
const report = (lines: ReadonlyArray<string>) =>
  ["begin v1 wait-ready", ...lines, "end " + lines.length].join("\n") + "\n";
const GOOD = ["ready ok 4343", "live ok " + LIVE, "compat ok " + COMPAT];

// The launch's definitions from wait_ready on, and its step from the launch files to readiness.
const launch = buildRemoteLaunchScript({ archiveVersion: version });
const between = (from: string, to: string, inclusive: boolean) => {
  const start = launch.indexOf(from);
  const end = launch.indexOf(to, start);
  assert.isAtLeast(start, 0, from);
  assert.isAbove(end, start, to);
  return launch.slice(start, inclusive ? end + to.length : end);
};
const DEFINITIONS = between("wait_ready() {", "\nreuse_live_server() {", false);
const READY_STEP = between(
  "  printf 'managed\\n' >\"$MANAGED_FILE\"\n",
  "\n    exit 1\n  fi\n",
  true,
);

// Answers come from files in HOME, so a test changes behaviour without changing the executable,
// whose bytes are in its key. A report runs report.sh, which may change the host mid-call.
const STAND_IN = [
  "#!/bin/sh",
  'printf \'%s\\n\' "$*" >> "$HOME/calls"',
  'case "$*" in',
  "  '__ssh-helper capabilities') . \"$HOME/caps.sh\" ;;",
  "  '__ssh-helper wait-ready '*' --report '*) . \"$HOME/report.sh\" ;;",
  "  '__ssh-helper wait-ready '*) exit 0 ;;",
  "  '__ssh-helper protocol --runtime-file '*) cat \"$HOME/live\" ;;",
  "  '__ssh-helper compat --port '*) cat \"$HOME/compat\" ;;",
  "  *) exit 2 ;;",
  "esac",
  "",
].join("\n");
const RUNNER = [
  "#!/bin/sh",
  "GOAT_ARCHIVE_VERSION='" + version + "'",
  "# End of the declarations GOAT reads without running this runner.",
  'exec "$HOME/.goat/runtime/goat/versions/' + version + '/goat" "$@"',
  "",
].join("\n");
// Git Bash stand-ins: uname, a fixed clock past every age gate, and ps -W from a file. Any cygpath
// call is recorded: the launch must not start one.
const PREFIX = [
  "uname() { printf 'MINGW64_NT\\n'; }",
  "date() { printf '4102444800\\n'; }",
  'ps() { cat "$HOME/ps-rows"; }',
  'cygpath() { echo "cygpath $*" >>"$HOME/calls"; return 1; }',
  "",
].join("\n");
const PS_HEADER = "      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND\n";
const PS_ROW = "     4242       1    4242       4242  ?         197609 10:00:00 /c/goat/goat\n";
const VARIABLES = [
  'STATE_DIR="$HOME/.goat/ssh-launch/key"',
  'DEFAULT_RUNTIME_FILE="$HOME/.goat/userdata/server-runtime.json"',
  'PORT_FILE="$STATE_DIR/port"; PID_FILE="$STATE_DIR/pid"; MANAGED_FILE="$STATE_DIR/managed"',
  'RUNNER_FILE="$STATE_DIR/run-t3.sh"; RUNNER_CANDIDATE_FILE="$STATE_DIR/run-t3.next.$$"',
  'FACT_MEMO="$RUNNER_CANDIDATE_FILE.facts"; : >"$FACT_MEMO"',
  "GOAT_HOST_WINDOWS=1; GOAT_ARCHIVE_MODE=1; SELECTED_VERSION=" + version,
  "REMOTE_PORT=4343; REMOTE_PID=4242",
  "",
].join("\n");
const COMMON =
  PREFIX + REMOTE_PROTOCOL_TOKEN_SCRIPT + "\n" + REMOTE_RUNNER_HINT_SCRIPT + "\n" + VARIABLES;
// The bound is the listener wait's concern; here every command runs as on a host without one. The
// server starts after the capability lookup ends, as a server's start outlasts one goat start.
const STUBS = [
  'launch_bounded() { shift; "$@"; }',
  // A clock that moves only when the launch pauses; a pause may run on-pause.sh.
  // With clock-back the wall clock reads as stepped back to 0 on every read. A wait of more than
  // 10 s ends the script, so an unbounded wait fails instead of hanging.
  'launch_now() { if [ -e "$HOME/clock-back" ]; then launch_now_us=0; else launch_now_us="$(cat "$HOME/clock-us")"; fi; }',
  'launch_pause() { echo $(( $(cat "$HOME/clock-us") + $1 )) >"$HOME/clock-us"; [ "$(cat "$HOME/clock-us")" -le 10000000 ] || exit 97; [ ! -e "$HOME/on-pause.sh" ] || . "$HOME/on-pause.sh"; }',
  'wait_launched_listener() { [ -e "$HOME/no-wait" ] || wait; [ ! -e "$HOME/after-caps.sh" ] || . "$HOME/after-caps.sh"; }',
  // A test home is no Git Bash drive path; its native form is marked with C:, or refused.
  'launch_native_path() { [ ! -e "$HOME/no-native" ] || return 1; LAUNCH_NATIVE="C:$1"; }',
  "server_owns_listener() { :; }",
  "",
].join("\n");
// What the next pairing asks first: the live server, then compat with it, as check_live_protocol
// and read_live_compat ask them, the latter through a pinned copy of the runner.
const PAIRING = [
  'cp "$RUNNER_FILE" "$RUNNER_CANDIDATE_FILE.pin"',
  'live_fact "$RUNNER_FILE" "$DEFAULT_RUNTIME_FILE" "$PORT_FILE" "$PID_FILE" || echo live-failed',
  'compat_fact "$RUNNER_CANDIDATE_FILE.pin" 4343 "$DEFAULT_RUNTIME_FILE" "$PORT_FILE" "$PID_FILE" 4242 || echo compat-failed',
  'rm -f "$RUNNER_CANDIDATE_FILE.pin"',
  "",
].join("\n");

const kind = (call: string) =>
  call === "__ssh-helper capabilities"
    ? "caps"
    : call.startsWith("__ssh-helper wait-ready ")
      ? call.includes(" --report ")
        ? "report"
        : "wait"
      : call.startsWith("__ssh-helper protocol ")
        ? "live"
        : call.startsWith("__ssh-helper compat ")
          ? "compat"
          : call;

const fixture = Effect.fn("launchReadyReport.fixture")(function* () {
  const home = yield* Effect.acquireRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-ready-report-"))),
    (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
  );
  const at = (name: string) => NodePath.join(home, name);
  const dir = at(".goat/runtime/goat/versions/" + version);
  const state = at(".goat/ssh-launch/key");
  const facts = at(".goat/ssh-launch/facts");
  const write = (name: string, value: string) => NodeFSP.writeFile(at(name), value);
  yield* Effect.promise(async () => {
    await NodeFSP.mkdir(dir, { recursive: true });
    await NodeFSP.mkdir(state, { recursive: true });
    await NodeFSP.mkdir(at(".goat/userdata"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(dir, "goat"), STAND_IN, { mode: 0o700 });
    await NodeFSP.writeFile(NodePath.join(dir, ".install-complete"), version + "\n");
    await NodeFSP.writeFile(NodePath.join(state, "run-t3.sh"), RUNNER, { mode: 0o700 });
    await NodeFSP.writeFile(NodePath.join(state, "port"), "4343\n");
    await NodeFSP.writeFile(NodePath.join(state, "pid"), "4242\n");
    await write(".goat/userdata/server-runtime.json", RECORD);
    await write("ps-rows", PS_HEADER + PS_ROW);
    await write("clock-us", "0\n");
    await write("calls", "");
    await write("live", LIVE + "\n");
    await write("compat", COMPAT + "\n");
    await write("caps.sh", "printf 'caps v1 facts wait-ready-report\\n'");
    await write("report", report(GOOD));
    await write("report.sh", 'cat "$HOME/report"');
  });
  const sh = (body: string) =>
    Effect.promise(async () => {
      const out = await exec("sh", ["-c", COMMON + body], { env: { ...process.env, HOME: home } });
      return out.stdout.split("\n").filter(Boolean);
    });
  const calls = () =>
    Effect.promise(async () => {
      const lines = (await NodeFSP.readFile(at("calls"), "utf8")).split("\n").filter(Boolean);
      await write("calls", "");
      return lines.map((line) => line.replaceAll(home, "HOME"));
    });
  return {
    write: (name: string, value: string) => Effect.promise(() => write(name, value)),
    remove: (name: string) => Effect.promise(() => NodeFSP.rm(at(name), { force: true })),
    read: (name: string) => Effect.promise(() => NodeFSP.readFile(at(name), "utf8")),
    // The launch's definitions and stubs, then body.
    script: (body: string) => sh(DEFINITIONS + STUBS + body),
    // The launch's definitions without the stubs.
    plain: (body: string) => sh(DEFINITIONS + body),
    list: (name: string) => Effect.promise(() => NodeFSP.readdir(at(name))),
    // The launch's own step from its launch files to a ready server, as the launch runs it.
    launch: (after = "") => sh(DEFINITIONS + STUBS + READY_STEP + "echo launch-ready\n" + after),
    fifo: (name: string) => Effect.promise(() => exec("mkfifo", [at(name)])),
    // launch_wait_ready alone, for answers that would take the launch's failure branch.
    wait: () =>
      sh(
        DEFINITIONS +
          STUBS +
          "launch_caps_begin; wait_launched_listener\n" +
          "if launch_wait_ready 1000; then echo ready; else echo not-ready; fi\n",
      ),
    pairing: () => sh(PAIRING),
    calls,
    asked: () => Effect.map(calls(), (lines) => lines.map(kind)),
    facts: () =>
      Effect.promise(async () =>
        (await NodeFSP.readdir(facts).catch(() => [] as string[]))
          .filter((name) => !name.startsWith("."))
          .sort(),
      ),
  };
});

const RECORDED = [
  "caps." + version + ".exe",
  "compat." + version + ".runner",
  "live." + version + ".runner",
];

describe("the launch's readiness wait reports the first pairing's facts", () => {
  it.effect(
    "after a launch on a supporting runtime, the first pairing starts goat for neither live nor compat",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        assert.deepEqual(yield* f.launch(), ["launch-ready"]);
        const launched = yield* f.asked();
        assert.deepEqual(yield* f.pairing(), [LIVE, COMPAT]);
        assert.deepEqual(yield* f.asked(), []);
        assert.deepEqual(launched, ["caps", "report"]);
        assert.deepEqual(yield* f.facts(), RECORDED);
      }).pipe(Effect.scoped),
  );

  // The bounded job turns off MSYS's argument conversion, so goat.exe needs native paths.
  it.effect(
    "the report names the launched port and, as native paths, the files the pairing's live check reads",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.launch();
        const [, call] = yield* f.calls();
        assert.match(
          call ?? "",
          /^__ssh-helper wait-ready 4343 [0-9]+ [0-9]+ --report --runtime-file C:HOME\/\.goat\/userdata\/server-runtime\.json --port-file C:HOME\/\.goat\/ssh-launch\/key\/port --pid-file C:HOME\/\.goat\/ssh-launch\/key\/pid$/u,
        );
      }).pipe(Effect.scoped),
  );

  it.effect("a server replaced after the capture is asked again by the pairing", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.launch();
      yield* f.calls();
      yield* f.write(
        ".goat/userdata/server-runtime.json",
        JSON.stringify({ pid: 4242, port: 4343, instanceId: "inst-2" }),
      );
      assert.deepEqual(yield* f.pairing(), [LIVE, COMPAT]);
      assert.deepEqual(yield* f.asked(), ["live", "compat"]);
    }).pipe(Effect.scoped),
  );

  it.effect("a record the server writes while the launch waits for it is captured", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.remove(".goat/userdata/server-runtime.json");
      // The third pause writes it; the wait checks every 0.1 s for 5 s.
      yield* f.write(
        "on-pause.sh",
        '[ "$(cat "$HOME/clock-us")" != 300000 ] || printf \'%s\' \'' +
          RECORD +
          '\' >"$HOME/.goat/userdata/server-runtime.json"',
      );
      assert.deepEqual(yield* f.launch(), ["launch-ready"]);
      assert.deepEqual(yield* f.asked(), ["caps", "report"]);
      assert.deepEqual(yield* f.facts(), RECORDED);
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    { name: "a record never written", remove: true },
    { name: "a record never written while the clock steps back", remove: true, back: true },
    {
      name: "a record that keeps naming an earlier server",
      record: JSON.stringify({ pid: 5151, port: 4343, instanceId: "inst-0" }),
    },
  ])("$name: after 5 s the separate wait runs and nothing is recorded", (c) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      if (c.remove === true) yield* f.remove(".goat/userdata/server-runtime.json");
      if (c.back === true) yield* f.write("clock-back", "");
      if (c.record !== undefined) yield* f.write(".goat/userdata/server-runtime.json", c.record);
      assert.deepEqual(yield* f.launch(), ["launch-ready"]);
      assert.deepEqual(yield* f.asked(), ["caps", "wait"]);
      assert.deepEqual(yield* f.facts(), ["caps." + version + ".exe"]);
      assert.equal((yield* f.read("clock-us")).trim(), "5000000");
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    {
      name: "the record's start key absent before the call and appearing during it",
      rows: PS_HEADER,
      during: "printf '%s' '" + PS_ROW + '\' >>"$HOME/ps-rows"; ',
    },
    {
      name: "the record rewritten during the call",
      during:
        'printf \'%s\' \'{"pid":4242,"port":4343,"instanceId":"inst-2"}\' >"$HOME/.goat/userdata/server-runtime.json"; ',
    },
    {
      name: "the executable replaced during the call",
      during: "printf '\\n# replaced\\n' >>\"$0\"; ",
    },
    {
      name: "compat refused for a changed instance",
      lines: [GOOD[0]!, GOOD[1]!, "compat fail changed"],
    },
    {
      name: "compat refused for a missing instance id",
      lines: [GOOD[0]!, GOOD[1]!, "compat fail unavailable"],
    },
    {
      name: "a live answer for another PID",
      lines: [GOOD[0]!, "live ok live " + version + " 1 1 5151 4343", "compat ok " + COMPAT],
    },
    {
      name: "a live answer from a historical record",
      lines: [GOOD[0]!, "live ok live " + version + " 1 1 0 4343", "compat ok " + COMPAT],
    },
    {
      name: "a compat answer that cannot drain",
      lines: [GOOD[0]!, GOOD[1]!, "compat ok compatible 0 inst-1"],
    },
  ])("$name: the server is ready and nothing is recorded", (c) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      if (c.rows !== undefined) yield* f.write("ps-rows", c.rows);
      if (c.lines !== undefined) yield* f.write("report", report(c.lines));
      if (c.during !== undefined) yield* f.write("report.sh", c.during + 'cat "$HOME/report"');
      assert.deepEqual(yield* f.launch(), ["launch-ready"]);
      assert.deepEqual(yield* f.asked(), ["caps", "report"]);
      assert.deepEqual(yield* f.facts(), ["caps." + version + ".exe"]);
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    { name: "no end line", text: "begin v1 wait-ready\n" + GOOD.join("\n") + "\n" },
    { name: "a wrong count", text: report(GOOD).replace("end 3", "end 2") },
    { name: "a line after the end", text: report(GOOD) + "live ok " + LIVE + "\n" },
    { name: "another call's frame", text: report(GOOD).replace("wait-ready", "facts") },
    { name: "an unknown tag", text: report([...GOOD, "port ok 4343"]) },
    { name: "a repeated tag", text: report([GOOD[0]!, GOOD[0]!, GOOD[1]!, GOOD[2]!]) },
    { name: "no ready line", text: report(GOOD.slice(1)) },
    { name: "no compat for a live server", text: report(GOOD.slice(0, 2)) },
    {
      name: "compat without a live server",
      text: report([GOOD[0]!, "live ok none unknown unknown unknown 0 0", GOOD[2]!]),
    },
    { name: "an unknown failure word", text: report([GOOD[0]!, GOOD[1]!, "compat fail later"]) },
    { name: "a ready line for another port", text: report(["ready ok 4444", GOOD[1]!, GOOD[2]!]) },
    { name: "a ready line without a port", text: report(["ready ok yes", GOOD[1]!, GOOD[2]!]) },
    { name: "a malformed live answer", text: report([GOOD[0]!, "live ok garbage"]) },
    { name: "a malformed compat answer", text: report([GOOD[0]!, GOOD[1]!, "compat ok garbage"]) },
    { name: "a nonzero exit", text: report(GOOD), status: 1 },
  ])("$name: the separate wait runs and nothing is recorded", (c) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.write("report", c.text);
      if (c.status !== undefined)
        yield* f.write("report.sh", 'cat "$HOME/report"; exit ' + c.status);
      assert.deepEqual(yield* f.launch(), ["launch-ready"]);
      assert.deepEqual(yield* f.asked(), ["caps", "report", "wait"]);
      assert.deepEqual(yield* f.facts(), ["caps." + version + ".exe"]);
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    { name: "an old runtime", caps: "printf 'caps v1 facts\\n'" },
    { name: "a failed capability lookup", caps: "exit 3" },
    {
      name: "the executable replaced after the lookup",
      after:
        "printf '\\n# replaced\\n' >>\"$HOME/.goat/runtime/goat/versions/" + version + '/goat"',
    },
  ])("$name: the launch keeps today's separate wait", (c) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      if (c.caps !== undefined) yield* f.write("caps.sh", c.caps);
      if (c.after !== undefined) yield* f.write("after-caps.sh", c.after);
      assert.deepEqual(yield* f.launch(), ["launch-ready"]);
      assert.deepEqual(yield* f.asked(), ["caps", "wait"]);
      assert.notInclude(yield* f.facts(), "live." + version + ".runner");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a capability lookup still running when the wait starts leaves today's separate wait",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        // The lookup answers only once the launch's step has ended; the listener wait does not wait.
        yield* f.fifo("gate");
        yield* f.write("no-wait", "");
        yield* f.write(
          "caps.sh",
          "read -r _ <\"$HOME/gate\"; printf 'caps v1 facts wait-ready-report\\n'",
        );
        assert.deepEqual(yield* f.launch("printf 'go\\n' >\"$HOME/gate\"; wait\n"), [
          "launch-ready",
        ]);
        assert.deepEqual((yield* f.asked()).sort(), ["caps", "wait"]);
        assert.notInclude(yield* f.facts(), "live." + version + ".runner");
      }).pipe(Effect.scoped),
  );

  it.effect.each([
    {
      name: "a server that did not answer",
      lines: ["ready fail timeout", "live fail unavailable"],
    },
  ])("$name: the wait fails without asking again", (c) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.write("report", report(c.lines));
      assert.deepEqual(yield* f.wait(), ["not-ready"]);
      assert.deepEqual(yield* f.asked(), ["caps", "report"]);
      assert.deepEqual(yield* f.facts(), ["caps." + version + ".exe"]);
    }).pipe(Effect.scoped),
  );
});
describe("the launch's background capability lookup", () => {
  it.effect("runs once per launch, so a port retry neither asks again nor shares its files", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      assert.deepEqual(
        yield* f.script(
          'launch_caps_begin; first="$LAUNCH_CAPS_FILE"; launch_caps_begin; wait\n' +
            '[ "$LAUNCH_CAPS_FILE" = "$first" ] && echo same\n',
        ),
        ["same"],
      );
      assert.deepEqual(yield* f.asked(), ["caps"]);
    }).pipe(Effect.scoped),
  );

  // Above every PID limit (Linux 2^22, macOS 99999), so no process can have it.
  const GONE = 2_147_483_646;
  it.effect("removes what a launch no longer running left behind, and only that", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const left = (pid: number, suffix: string) =>
        ".goat/ssh-launch/key/run-t3.next." + pid + ".facts." + suffix;
      for (const suffix of [
        "caps-answer",
        "caps-answer.next",
        "caps-status",
        "caps-out",
        "report",
      ]) {
        yield* f.write(left(GONE, suffix), "x\n");
        yield* f.write(left(process.pid, suffix), "x\n");
      }
      yield* f.script("launch_caps_begin; wait\n");
      const kept = yield* f.list(".goat/ssh-launch/key");
      assert.deepEqual(
        kept.filter((name) => name.startsWith("run-t3.next." + GONE)),
        [],
      );
      assert.lengthOf(
        kept.filter((name) => name.startsWith("run-t3.next." + process.pid + ".")),
        5,
      );
    }).pipe(Effect.scoped),
  );
});
describe("the report's native paths", () => {
  it.effect.each([
    {
      path: "/c/Users/u/.goat/userdata/server-runtime.json",
      native: "c:/Users/u/.goat/userdata/server-runtime.json",
    },
    { path: "/D/goat home/port", native: "D:/goat home/port" },
    { path: "/tmp/goat/port", native: "refused" },
    { path: "/cc/goat/port", native: "refused" },
    { path: "/c", native: "refused" },
    { path: "c/goat/port", native: "refused" },
    { path: "/1/goat/port", native: "refused" },
  ])("$path converts without a process: $native", ({ path, native }) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const out = yield* f.plain(
        "if launch_native_path '" +
          path +
          "'; then printf '%s\\n' \"$LAUNCH_NATIVE\"; else echo refused; fi\n",
      );
      assert.deepEqual(out, [native]);
      assert.deepEqual(yield* f.calls(), []);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a home outside Git Bash's drive paths keeps today's separate wait and asks nothing more",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.write("no-native", "");
        assert.deepEqual(yield* f.launch(), ["launch-ready"]);
        assert.deepEqual(yield* f.asked(), ["wait"]);
        assert.deepEqual(yield* f.facts(), []);
      }).pipe(Effect.scoped),
  );
});
