// @effect-diagnostics nodeBuiltinImport:off - runs the generated launch's candidate checks against a temporary home.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
import { it } from "@effect/vitest";
import { assert, describe } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { buildRemoteLaunchScript } from "./tunnel.ts";

const version = "1.2.3";
const OWN =
  version + " " + SSH_RUNTIME_PROTOCOL_VERSION + " " + ORCHESTRATION_PROTOCOL_VERSION + " 0 0";
const NONE = "none unknown unknown unknown 0 0";
const LIVE =
  "live " +
  version +
  " " +
  SSH_RUNTIME_PROTOCOL_VERSION +
  " " +
  ORCHESTRATION_PROTOCOL_VERSION +
  " 4242 4343";
const RECORD = JSON.stringify({ pid: 4242, port: 4343, instanceId: "inst-1" });
const PS_HEADER = "      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND\n";
const psRow = (stime: string) =>
  "     4242       1    4242       4242  ?         197609 " + stime + " /c/goat/goat\n";

// The launch's own lines: its setup definitions (variables, facts, runner hints and whatever the
// setup defines before its retained-runner check), then its steps from pinning the candidate runner
// to the check that the candidate did not change. A hook runs before its live check.
const launchFor = (ownRuntimeVersion: string) => {
  const launch = buildRemoteLaunchScript({ archiveVersion: version, ownRuntimeVersion });
  const between = (from: string, to: string) => {
    const start = launch.indexOf(from);
    const end = launch.indexOf(to, start);
    assert.isAtLeast(start, 0, from);
    assert.isAbove(end, start, to);
    return launch.slice(start, end);
  };
  const steps = between('\npin_runner "$RUNNER_NEXT"\n', "\npublish_selected_runner() {");
  const hooked = steps.replace(
    "\ncheck_candidate_protocol\ncheck_live_protocol\n",
    '\ncheck_candidate_protocol\n[ ! -f "$HOME/between.sh" ] || . "$HOME/between.sh"\ncheck_live_protocol\n',
  );
  assert.notEqual(hooked, steps);
  return {
    definitions: between(
      'RUNNER_FILE="$STATE_DIR/run-t3.sh"\nRUNNER_NEXT',
      "\ncheck_retained_runner() {",
    ),
    steps: hooked,
  };
};

// Git Bash stand-ins. The clock and every file's times come from files in HOME, so a test can make
// a file young or rewrite it within one second; ps -W rows come from a file.
const PREFIX = `unset EPOCHSECONDS 2>/dev/null || :
uname() { printf 'MINGW64_NT-10.0\\n'; }
date() { cat "$HOME/clock"; }
ps() { cat "$HOME/ps-rows"; }
stat() {
  while [ "$#" -gt 0 ]; do case "$1" in -c|-f) shift 2 ;; *) break ;; esac; done
  for stat_file in "$@"; do
    [ -e "$stat_file" ] || return 1
    stat_inode="$(ls -di "$stat_file" | awk '{ print $1 }')"
    stat_size="$(wc -c <"$stat_file")"; stat_size="\${stat_size##* }"
    stat_time=1000
    while read -r stat_glob stat_value; do
      case "$stat_file" in $stat_glob) stat_time="$stat_value" ;; esac
    done <"$HOME/times"
    printf '1:%s:%s:%s:%s\\n' "$stat_inode" "$stat_size" "$stat_time" "$stat_time"
  done
}
STATE_DIR="$HOME/.goat/ssh-launch/key"; DEFAULT_SERVER_HOME="$HOME/.goat"
`;
// Settings a launch on a host without retained-runner reuse or ownership repair runs with; a test
// may override them in settings.sh.
const SETTINGS = [
  "ALLOW_OWNED_UPGRADE=0; ALLOW_LEGACY_ADOPTION=0",
  '[ ! -f "$HOME/settings.sh" ] || . "$HOME/settings.sh"',
  'mkdir -p "$STATE_DIR"; FACT_MEMO="$RUNNER_CANDIDATE_FILE.facts"; fact_memo_drop',
  'cp "$HOME/runner" "$RUNNER_NEXT"; chmod 700 "$RUNNER_NEXT"',
  "",
].join("\n");
// What an owning launch asks next through the pinned runner, under the host lock.
const OWNER = [
  "",
  '[ ! -f "$HOME/before-pin.sh" ] || . "$HOME/before-pin.sh"',
  'CHECK_RUNNER="$RUNNER_CANDIDATE_FILE.pin"',
  "check_live_protocol",
  "check_candidate_protocol",
  'printf \'result %s %s\\n\' "$LIVE_STATUS" "$RUNNER_VERSION_OUTPUT"',
  "",
].join("\n");

// The goat stand-in answers from files in HOME. Its facts frame answers each asked question from
// facts-<question> when present (a "fail ..." text is a failed answer), else from the file the
// separate command reads, and adds compat after a live server.
const STAND_IN = `#!/bin/sh
printf '%s\\n' "$*" >>"$HOME/calls"
case "$*" in
  --version) cat "$HOME/version" ;;
  '__ssh-helper protocol --shell') cat "$HOME/own" ;;
  '__ssh-helper protocol --runtime-file '*) cat "$HOME/live" ;;
  '__ssh-helper compat --port '*) cat "$HOME/compat" ;;
  '__ssh-helper facts '*)
    answer() { if [ -f "$HOME/facts-$1" ]; then cat "$HOME/facts-$1"; else cat "$HOME/$1"; fi; }
    printf 'begin v1 facts\\n'
    [ -e "$HOME/facts-no-caps" ] || printf 'caps v1 facts wait-ready-report\\n'
    n=0
    for arg in "$@"; do
      case "$arg" in --version|--own|--live) ;; *) continue ;; esac
      tag="\${arg#--}"
      [ ! -e "$HOME/facts-drop-$tag" ] || continue
      value="$(answer "$tag")"
      case "$value" in "fail "*) printf '%s %s\\n' "$tag" "$value" ;; *) printf '%s ok %s\\n' "$tag" "$value" ;; esac
      n=$((n + 1))
      case "$tag $value" in "live live "*) printf 'compat ok %s\\n' "$(cat "$HOME/compat")"; n=$((n + 1)) ;; esac
    done
    printf 'end %s\\n' "$n"
    [ ! -f "$HOME/facts-stderr" ] || cat "$HOME/facts-stderr" >&2
    [ ! -f "$HOME/during-facts.sh" ] || . "$HOME/during-facts.sh"
    exit "$(cat "$HOME/facts-status" 2>/dev/null || echo 0)" ;;
  *) exit 2 ;;
esac
`;
const RUNNER = [
  "#!/bin/sh",
  "GOAT_ARCHIVE_VERSION='" + version + "'",
  "# End of the declarations GOAT reads without running this runner.",
  'exec "$HOME/.goat/runtime/goat/versions/' + version + '/goat" "$@"',
  "",
].join("\n");

const kind = (call: string) =>
  call === "--version"
    ? "version"
    : call === "__ssh-helper protocol --shell"
      ? "own"
      : call.startsWith("__ssh-helper protocol --runtime-file ")
        ? "live"
        : call.startsWith("__ssh-helper compat ")
          ? "compat"
          : call.startsWith("__ssh-helper facts ")
            ? "facts"
            : call;

const fixture = Effect.fn("launchFacts.fixture")(function* (ownRuntimeVersion = version) {
  const home = yield* Effect.acquireRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-launch-facts-"))),
    (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
  );
  const at = (name: string) => NodePath.join(home, name);
  const write = (name: string, value: string) => NodeFSP.writeFile(at(name), value);
  const dir = at(".goat/runtime/goat/versions/" + version);
  yield* Effect.promise(async () => {
    await NodeFSP.mkdir(dir, { recursive: true });
    await NodeFSP.mkdir(at(".goat/userdata"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(dir, "goat"), STAND_IN, { mode: 0o700 });
    await NodeFSP.writeFile(NodePath.join(dir, ".install-complete"), version + "\n");
    await write("runner", RUNNER);
    await write("version", "goat v" + version + "\n");
    await write("own", OWN + "\n");
    await write("live", NONE + "\n");
    await write("compat", "compatible 1 inst-1\n");
    await write("ps-rows", PS_HEADER);
    await write("calls", "");
    // The executable is long installed; the pin is written in the second the launch reads.
    await write("clock", "5000\n");
    await write("times", "*.pin 5000\n");
  });
  const { definitions, steps } = launchFor(ownRuntimeVersion);
  const run = () =>
    Effect.promise(
      () =>
        new Promise<{ code: number; out: string[]; err: string }>((resolve) => {
          const child = NodeChildProcess.execFile(
            "sh",
            ["-c", PREFIX + definitions + "\n" + SETTINGS + steps + OWNER],
            { env: { ...process.env, HOME: home } },
            (_error, stdout, stderr) =>
              resolve({
                code: child.exitCode ?? -1,
                out: stdout.split("\n").filter(Boolean),
                err: stderr,
              }),
          );
        }),
    );
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
    run,
    calls,
    asked: () => Effect.map(calls(), (lines) => lines.map(kind)),
    // The launch, then the kinds of goat starts it made.
    launch: () =>
      Effect.gen(function* () {
        const result = yield* run();
        return { ...result, asked: (yield* calls()).map(kind) };
      }),
    fact: (name: string) =>
      Effect.promise(() =>
        NodeFSP.readFile(at(".goat/ssh-launch/facts/" + name), "utf8").then(
          (text) => text.split("\n")[1],
          () => undefined,
        ),
      ),
    // A bound server: its record, the launch files naming it, and its ps -W row.
    serve: (live = LIVE) =>
      Effect.promise(async () => {
        await NodeFSP.mkdir(at(".goat/ssh-launch/key"), { recursive: true });
        await write(".goat/userdata/server-runtime.json", RECORD);
        await write(".goat/ssh-launch/key/port", "4343\n");
        await write(".goat/ssh-launch/key/pid", "4242\n");
        await write(".goat/ssh-launch/key/managed", "managed\n");
        await write(".goat/ssh-launch/key/identity", "goat serve\n");
        await write("ps-rows", PS_HEADER + psRow("10:00:00"));
        await write("live", live + "\n");
      }),
  };
});

describe("a fresh own-version launch asks its pinned candidate runner once", () => {
  it.effect(
    "asks version, own protocol and live in one start where three separate starts ran",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const launch = yield* f.launch();
        assert.equal(launch.code, 0, launch.err);
        assert.deepEqual(launch.asked, ["facts"]);
        assert.deepEqual(launch.out, ["result none goat v" + version]);
        assert.equal(yield* f.fact("version." + version + ".runner"), "goat v" + version);
        assert.equal(yield* f.fact("own." + version + ".runner"), OWN);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "the one start asks through the pinned runner with the capability line and the launch files",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.run();
        assert.deepEqual(yield* f.calls(), [
          "__ssh-helper facts --with-caps --version --own --live --runtime-file HOME/.goat/userdata/server-runtime.json --port-file HOME/.goat/ssh-launch/key/port --pid-file HOME/.goat/ssh-launch/key/pid",
        ]);
      }).pipe(Effect.scoped),
  );

  it.effect.each([
    { name: "a missing own line", file: "facts-drop-own", value: "" },
    { name: "another version's text", file: "facts-version", value: "goat v9.9.9" },
    { name: "a failed version answer", file: "facts-version", value: "fail error" },
    { name: "malformed own tokens", file: "facts-own", value: version + " x" },
    {
      name: "own tokens of another version",
      file: "facts-own",
      value: "1.2.4 " + OWN.slice(version.length + 1),
    },
    { name: "malformed live tokens", file: "facts-live", value: "live bogus" },
    { name: "no capability line", file: "facts-no-caps", value: "" },
    { name: "a failed exit", file: "facts-status", value: "1" },
    { name: "anything on stderr", file: "facts-stderr", value: "warning" },
  ])(
    "a frame with $name is used for nothing: the three separate starts follow",
    ({ file, value }) =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.write(file, value);
        const launch = yield* f.launch();
        assert.equal(launch.code, 0, launch.err);
        assert.deepEqual(launch.asked, ["facts", "version", "own", "live"]);
        assert.deepEqual(launch.out, ["result none goat v" + version]);
      }).pipe(Effect.scoped),
  );

  it.effect.each([
    {
      name: "the executable",
      during: 'printf "*/versions/' + version + '/goat 1001\\n" >>"$HOME/times"',
      code: 0,
    },
    {
      name: "the pinned runner",
      during:
        'for pin in "$HOME"/.goat/ssh-launch/key/*.pin; do printf "# changed\\n" >>"$pin"; done',
      code: 1,
    },
  ])("$name changing during the call keeps nothing from it", ({ during, code }) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.write("during-facts.sh", during + "\n");
      const launch = yield* f.launch();
      assert.equal(launch.code, code, launch.err);
      assert.deepEqual(launch.asked, ["facts", "version", "own", "live"]);
    }).pipe(Effect.scoped),
  );

  it.effect("a candidate of another version than the client's own is asked separately", () =>
    Effect.gen(function* () {
      const f = yield* fixture("1.2.4");
      const launch = yield* f.launch();
      assert.equal(launch.code, 0, launch.err);
      assert.deepEqual(launch.asked, ["version", "own", "live"]);
    }).pipe(Effect.scoped),
  );

  // The declared extension covers only this launch's own candidate: its frame answers are taken
  // as the separate commands' even where a stand-in makes them differ; a retained runner never is.
  it.effect(
    "the own candidate's frame answers stand for the separate commands'; a retained runner is never asked the frame",
    () =>
      Effect.gen(function* () {
        const differing = version + " " + SSH_RUNTIME_PROTOCOL_VERSION + " unknown 0 0";
        const own = yield* fixture();
        yield* own.write("facts-own", differing);
        assert.deepEqual((yield* own.launch()).asked, ["facts"]);
        assert.equal(yield* own.fact("own." + version + ".runner"), differing);
        const retained = yield* fixture();
        yield* retained.write("facts-own", differing);
        yield* retained.write("settings.sh", "PRESERVE_SELECTED_RUNNER=1\n");
        const launch = yield* retained.launch();
        assert.equal(launch.code, 0, launch.err);
        assert.deepEqual(launch.asked, ["version", "own", "live"]);
        assert.equal(yield* retained.fact("own." + version + ".runner"), OWN);
      }).pipe(Effect.scoped),
  );

  it.effect("recorded answers are not asked again: only the missing questions are", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      assert.deepEqual((yield* f.launch()).asked, ["facts"]);
      // Version and own stay recorded; the no-server answer was this launch's alone.
      assert.deepEqual((yield* f.launch()).asked, ["live"]);
      yield* f.remove(".goat/ssh-launch/facts/own." + version + ".runner");
      yield* f.run();
      assert.deepEqual(yield* f.calls(), [
        "__ssh-helper facts --with-caps --own --live --runtime-file HOME/.goat/userdata/server-runtime.json --port-file HOME/.goat/ssh-launch/key/port --pid-file HOME/.goat/ssh-launch/key/pid",
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("an executable without an exec key is asked separately", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.write("times", "*.pin 5000\n*/versions/" + version + "/goat 5000\n");
      const launch = yield* f.launch();
      assert.equal(launch.code, 0, launch.err);
      // Nothing can be recorded, so every check asks again, as before.
      assert.deepEqual(launch.asked, [
        "version",
        "version",
        "own",
        "live",
        "live",
        "version",
        "own",
      ]);
    }).pipe(Effect.scoped),
  );

  // A pin written in the current second keeps its signature through a same-size rewrite in that
  // second; only its digest tells the answers apart.
  it.effect(
    "a young pin rewritten in the same second at the same size misses the frame's answers",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.write(
          "before-pin.sh",
          'sed "s/End of/End-of/" "$HOME/runner" >"$RUNNER_CANDIDATE_FILE.pin"\n',
        );
        const launch = yield* f.launch();
        assert.equal(launch.code, 0, launch.err);
        assert.deepEqual(launch.asked, ["facts", "live", "version", "own"]);
      }).pipe(Effect.scoped),
  );
});

describe("the frame's live answer is used only while its inputs hold", () => {
  // Live inputs that change during the call void the whole frame, like a changed exec key.
  it.effect.each([
    {
      name: "a launch file appearing during the call",
      file: "during-facts.sh",
      asked: ["facts", "version", "own", "live", "live"],
    },
    {
      name: "a launch file appearing before the live check",
      file: "between.sh",
      asked: ["facts", "live", "live"],
    },
  ])("$name makes the live check ask goat", ({ file, asked }) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      // The hook runs in goat's process or the launch's; it names the port file by its path.
      yield* f.write(file, 'printf "4343\\n" >"$HOME/.goat/ssh-launch/key/port"\n');
      const launch = yield* f.launch();
      assert.equal(launch.code, 0, launch.err);
      assert.deepEqual(launch.asked, asked);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a bound server's live answer is used while its key holds, and a later launch asks nothing",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.serve();
        const launch = yield* f.launch();
        assert.equal(launch.code, 0, launch.err);
        assert.deepEqual(launch.asked, ["facts", "compat"]);
        assert.deepEqual(launch.out, ["result live goat v" + version]);
        assert.deepEqual((yield* f.launch()).asked, []);
      }).pipe(Effect.scoped),
  );

  it.effect.each([
    {
      name: "during the call",
      file: "during-facts.sh",
      asked: ["facts", "version", "own", "live", "compat"],
    },
    { name: "before the live check", file: "between.sh", asked: ["facts", "live", "compat"] },
  ])("a bound server restarted $name makes the live check ask goat", ({ file, asked }) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.serve();
      yield* f.write("ps-rows-next", PS_HEADER + psRow("10:00:05"));
      yield* f.write(file, 'cp "$HOME/ps-rows-next" "$HOME/ps-rows"\n');
      const launch = yield* f.launch();
      assert.equal(launch.code, 0, launch.err);
      assert.deepEqual(launch.asked, asked);
    }).pipe(Effect.scoped),
  );

  it.effect("an unbound live answer is never reused", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.serve(LIVE.replace(" 4242 ", " 0 "));
      const launch = yield* f.launch();
      assert.deepEqual(launch.asked.slice(0, 2), ["facts", "live"]);
    }).pipe(Effect.scoped),
  );
});
