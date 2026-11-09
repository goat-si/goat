// @effect-diagnostics nodeBuiltinImport:off - runs the real generated probe script against a temporary home.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { it } from "@effect/vitest";
import { assert, describe } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { buildRemoteRuntimeProbeScript } from "./runtimeProbe.ts";
import { OLD_HELPER_CAPS_STDERR } from "./runtimeFactsScripts.ts";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const version = "1.2.3";
const MANIFEST = version + " 1 1 1700000000 has";
const LIVE = "live " + version + " 1 1 4242 4343";
const COMPAT = "compatible 1 inst-1";
const SIGNALS = {
  serverVersion: version,
  sshRuntimeProtocolVersion: 1,
  orchestrationProtocolVersion: 1,
};
const frame = (lines: ReadonlyArray<string>) =>
  ["begin v1 facts", ...lines, "end " + lines.length].join("\n") + "\n";
const GOOD = [
  "manifest ok " + MANIFEST,
  "commit ok 1700000000",
  "live ok " + LIVE,
  "compat ok " + COMPAT,
];
const CAPS = "__ssh-helper capabilities";
const FACTS =
  "__ssh-helper facts --runtime-file HOME/.goat/userdata/server-runtime.json" +
  " --port-file HOME/.goat/ssh-launch//port --pid-file HOME/.goat/ssh-launch//pid";
const MANIFEST_ASK = "__ssh-helper runtime-manifest --shell";
const COMMIT_ASK = "__ssh-helper commit-time";
const LIVE_ASK =
  "__ssh-helper protocol --runtime-file HOME/.goat/userdata/server-runtime.json" +
  " --port-file HOME/.goat/ssh-launch//port --pid-file HOME/.goat/ssh-launch//pid --shell";
const COMPAT_ASK = "__ssh-helper compat --port 4343";
const SEPARATE = [MANIFEST_ASK, COMMIT_ASK, LIVE_ASK, COMPAT_ASK];

// Every answer comes from a file in HOME, so a test changes behaviour without changing the
// executable's bytes, which would change its key.
const STAND_IN = [
  "#!/bin/sh",
  'printf \'%s\\n\' "$*" >> "$HOME/calls"',
  'case "$*" in',
  "  '__ssh-helper capabilities') . \"$HOME/caps.sh\" ;;",
  "  '__ssh-helper facts '*) . \"$HOME/facts.sh\" ;;",
  "  '__ssh-helper runtime-manifest --shell') cat \"$HOME/manifest\" ;;",
  "  '__ssh-helper commit-time') printf '1700000000\\n' ;;",
  "  '__ssh-helper protocol --runtime-file '*) cat \"$HOME/live\" ;;",
  "  '__ssh-helper compat --port '*) cat \"$HOME/compat\" ;;",
  "  *) exit 2 ;;",
  "esac",
  "",
].join("\n");
const ANSWER_CAPS =
  'cat "$HOME/caps-out"; cat "$HOME/caps-err" >&2; exit "$(cat "$HOME/caps-status")"';
const ANSWER_FRAME = 'cat "$HOME/frame"';
const REPLACE_SELF = "printf '\\n# replaced\\n' >> \"$0\"; ";

// Git Bash stand-ins: uname, a fixed clock past every age gate, and ps -W listing the server.
const PREFIX =
  "uname() { printf 'MINGW64_NT\\n'; }\n" +
  "date() { printf '4102444800\\n'; }\n" +
  "ps() { printf '%s\\n' '      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND'" +
  " '     4242       1    4242       4242  ?         197609 10:00:00 /c/goat/goat'; }\n";
const TAIL = [
  "binary_json \"$V\" || printf 'binary-failed'; printf '\\n'",
  "build_commit_time \"$exe\" || printf 'no-commit'; printf '\\n'",
  'live_fact "$exe" "$runtime_file" "$state/port" "$state/pid" || printf \'live-failed\\n\'',
  'compat_fact "$exe" 4343 "$runtime_file" "$state/port" "$state/pid" 4242 || printf \'compat-failed\\n\'',
].join("\n");
const ANSWERED = [JSON.stringify(SIGNALS), "1700000000", LIVE, COMPAT];

const fixture = Effect.fn("runtimeProbe.factsFrame.fixture")(function* () {
  const home = yield* Effect.promise(() =>
    NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-probe-frame-")),
  );
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => NodeFSP.rm(home, { recursive: true, force: true })),
  );
  const dir = NodePath.join(home, ".goat/runtime/goat/versions", version);
  const exe = NodePath.join(dir, "goat");
  const facts = NodePath.join(home, ".goat/ssh-launch/facts");
  const record = NodePath.join(home, ".goat/userdata/server-runtime.json");
  const write = (name: string, value: string) =>
    NodeFSP.writeFile(NodePath.join(home, name), value);
  const hash = NodeCrypto.createHash("sha256").update(STAND_IN).digest("hex");
  yield* Effect.promise(async () => {
    await NodeFSP.mkdir(dir, { recursive: true });
    await NodeFSP.mkdir(NodePath.dirname(record), { recursive: true });
    await NodeFSP.writeFile(exe, STAND_IN, { mode: 0o700 });
    await NodeFSP.writeFile(NodePath.join(dir, ".install-complete"), version + "\n");
    await NodeFSP.writeFile(
      NodePath.join(dir, "goat-manifest-shell-v1.sha256"),
      version + " " + hash + "\n",
    );
    await NodeFSP.writeFile(
      NodePath.join(dir, ".install-record"),
      version + " " + "a".repeat(64) + " " + hash + " cache\n",
    );
    await NodeFSP.writeFile(
      record,
      JSON.stringify({ pid: 4242, port: 4343, startedAt: "2026-11-10T00:00:00.000Z" }),
    );
    await write("calls", "");
    await write("manifest", MANIFEST + "\n");
    await write("live", LIVE + "\n");
    await write("compat", COMPAT + "\n");
    await write("caps-out", "usage\n");
    await write("caps-err", OLD_HELPER_CAPS_STDERR);
    await write("caps-status", "1");
    await write("caps.sh", ANSWER_CAPS);
    await write("facts.sh", ANSWER_FRAME);
    await write("frame", frame(GOOD));
  });
  const generated = buildRemoteRuntimeProbeScript(version);
  const boundary = generated.indexOf("\nretained_version=");
  assert.isAbove(boundary, 0);
  const script = PREFIX + generated.slice(0, boundary) + "\n";
  const run = (tail = TAIL) =>
    Effect.promise(async () => {
      const out = await exec("sh", ["-c", script + tail], { env: { ...process.env, HOME: home } });
      return out.stdout.split("\n").filter(Boolean);
    });
  return {
    home,
    record,
    run,
    write: (name: string, value: string) => Effect.promise(() => write(name, value)),
    supporting: () =>
      Effect.promise(async () => {
        await write("caps-out", "caps v1 facts\n");
        await write("caps-err", "");
        await write("caps-status", "0");
      }),
    asks: () =>
      Effect.promise(async () =>
        (await NodeFSP.readFile(NodePath.join(home, "calls"), "utf8"))
          .replaceAll(home, "HOME")
          .split("\n")
          .filter(Boolean),
      ),
    facts: () =>
      Effect.promise(async () =>
        (await NodeFSP.readdir(facts).catch(() => [] as string[]))
          .filter((name) => !name.startsWith("."))
          .sort(),
      ),
    fact: (name: string) =>
      Effect.promise(() => NodeFSP.readFile(NodePath.join(facts, name), "utf8")),
    forgetManifest: () =>
      Effect.promise(async () => {
        for (const name of ["version", "own"])
          await NodeFSP.rm(NodePath.join(facts, name + "." + version + ".exe"), { force: true });
      }),
  };
});

describe("the first probe's facts in one start", () => {
  it.effect("a supporting runtime answers manifest, commit, live and compat with one start", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.supporting();
      assert.deepEqual(yield* f.run(), ANSWERED);
      assert.deepEqual(yield* f.asks(), [CAPS, FACTS]);
      const stored = ["caps", "commit", "compat", "live", "own", "version"].map(
        (kind) => kind + "." + version + ".exe",
      );
      assert.deepEqual(yield* f.facts(), stored);
      assert.equal((yield* f.fact("caps." + version + ".exe")).split("\n")[1], "caps v1 facts");
      // The next probe finds every answer recorded.
      assert.deepEqual(yield* f.run(), ANSWERED);
      assert.deepEqual(yield* f.asks(), [CAPS, FACTS]);
    }).pipe(Effect.scoped),
  );

  it.effect("an old runtime is asked once per install and keeps today's separate calls", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      assert.deepEqual(yield* f.run(), ANSWERED);
      assert.deepEqual(yield* f.asks(), [CAPS, ...SEPARATE]);
      assert.equal((yield* f.fact("caps." + version + ".exe")).split("\n")[1], "caps v1");
      yield* f.forgetManifest();
      assert.deepEqual(yield* f.run(), ANSWERED);
      assert.deepEqual(yield* f.asks(), [CAPS, ...SEPARATE, MANIFEST_ASK]);
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    {
      name: "near-miss stderr",
      err: OLD_HELPER_CAPS_STDERR.replace("ERROR", "ERRORS"),
      status: "1",
    },
    { name: "extra stderr line", err: OLD_HELPER_CAPS_STDERR + "more\n", status: "1" },
    { name: "stderr over 4096 bytes", err: OLD_HELPER_CAPS_STDERR + "x".repeat(5000), status: "1" },
    // The exact old answer, but its stdout was cut at the bound: a capture that did not arrive whole.
    {
      name: "stdout over 4096 bytes",
      out: "x".repeat(5000) + "\n",
      err: OLD_HELPER_CAPS_STDERR,
      status: "1",
    },
    { name: "exit 2", err: OLD_HELPER_CAPS_STDERR, status: "2" },
    // A capture must not take its status from what the helper printed.
    {
      name: "stdout naming another status",
      out: "x".repeat(4077) + "\n:goat-caps-exit:1:" + "y".repeat(100),
      err: OLD_HELPER_CAPS_STDERR,
      status: "2",
    },
    {
      name: "stderr naming another status",
      err: OLD_HELPER_CAPS_STDERR + ".\n1\n",
      status: "2",
    },
    { name: "two stdout lines", out: "caps v1 facts\ncaps v1 facts\n", status: "0" },
    { name: "unknown name", out: "caps v1 facts teleport\n", status: "0" },
    { name: "repeated name", out: "caps v1 facts facts\n", status: "0" },
    { name: "trailing space", out: "caps v1 facts \n", status: "0" },
    { name: "stderr beside a valid line", out: "caps v1 facts\n", err: "warning\n", status: "0" },
    { name: "a signal", script: "kill -TERM $$" },
  ])("$name is used as no capabilities and never recorded", (answer) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      if (answer.script !== undefined) yield* f.write("caps.sh", answer.script);
      yield* f.write("caps-out", answer.out ?? "usage\n");
      yield* f.write("caps-err", answer.err ?? "");
      yield* f.write("caps-status", answer.status ?? "0");
      assert.deepEqual(yield* f.run(), ANSWERED);
      assert.deepEqual(yield* f.asks(), [CAPS, ...SEPARATE]);
      assert.notInclude(yield* f.facts(), "caps." + version + ".exe");
    }).pipe(Effect.scoped),
  );

  it.effect("a transient failure is asked again and the recovered answer is recorded", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.write("caps-status", "2");
      yield* f.run();
      yield* f.forgetManifest();
      yield* f.supporting();
      yield* f.run();
      assert.deepEqual(yield* f.asks(), [CAPS, ...SEPARATE, CAPS, FACTS]);
      assert.equal((yield* f.fact("caps." + version + ".exe")).split("\n")[1], "caps v1 facts");
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    { name: "during the combined call", caps: false },
    { name: "between the capability lookup and the call", caps: true },
  ])("an executable replaced $name discards the reply and stores nothing from it", ({ caps }) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.supporting();
      yield* f.write(
        caps ? "caps.sh" : "facts.sh",
        REPLACE_SELF + (caps ? ANSWER_CAPS : ANSWER_FRAME),
      );
      const answered = yield* f.run();
      // The replacement no longer matches the install record's hash, so the manifest is refused.
      assert.deepEqual(answered, [
        JSON.stringify({ serverVersion: version, invalid: true }),
        ...ANSWERED.slice(1),
      ]);
      assert.deepEqual(yield* f.asks(), [CAPS, FACTS, ...SEPARATE]);
      if (caps) assert.notInclude(yield* f.facts(), "caps." + version + ".exe");
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    { name: "no begin line", text: GOOD.join("\n") + "\nend 4\n" },
    { name: "another version", text: frame(GOOD).replace("begin v1", "begin v2") },
    { name: "a wrong count", text: frame(GOOD).replace("end 4", "end 5") },
    { name: "a line after end", text: frame(GOOD) + "live ok " + LIVE + "\n" },
    { name: "an unknown tag", text: frame([...GOOD, "port ok 4343"]) },
    { name: "a repeated tag", text: frame([...GOOD, "commit ok 1700000000"]) },
    { name: "a missing tag", text: frame(GOOD.filter((line) => !line.startsWith("commit"))) },
    {
      name: "compat without a live server",
      text: frame([GOOD[0]!, GOOD[1]!, "live ok none unknown unknown unknown 0 0", GOOD[3]!]),
    },
    { name: "a live server without compat", text: frame(GOOD.slice(0, 3)) },
    {
      name: "an unknown failure word",
      text: frame([GOOD[0]!, "commit fail nope", GOOD[2]!, GOOD[3]!]),
    },
    {
      name: "words after a failure",
      text: frame([GOOD[0]!, "commit fail error now", GOOD[2]!, GOOD[3]!]),
    },
    { name: "an empty answer", text: frame([GOOD[0]!, "commit ok", GOOD[2]!, GOOD[3]!]) },
    { name: "no output", text: "" },
    { name: "a nonzero exit", text: frame(GOOD), status: 3 },
  ])("a frame with $name is not used and the separate calls run", ({ text, status }) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.supporting();
      yield* f.write("frame", text);
      if (status !== undefined) yield* f.write("facts.sh", ANSWER_FRAME + "; exit " + status);
      assert.deepEqual(yield* f.run(), ANSWERED);
      assert.deepEqual(yield* f.asks(), [CAPS, FACTS, ...SEPARATE]);
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    { name: "commit ok 0", line: 1, answer: "commit ok 0", output: "no-commit" },
    {
      name: "commit fail unavailable",
      line: 1,
      answer: "commit fail unavailable",
      output: "no-commit",
    },
    {
      name: "manifest fail error",
      line: 0,
      answer: "manifest fail error",
      output: JSON.stringify({ serverVersion: version, invalid: true }),
    },
    {
      name: "manifest ok with four tokens",
      line: 0,
      answer: "manifest ok " + version + " 1 1 0",
      output: JSON.stringify({ serverVersion: version, invalid: true }),
    },
  ])(
    "$name takes that question's failure branch without asking again",
    ({ line, answer, output }) =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.supporting();
        yield* f.write("frame", frame(GOOD.map((value, at) => (at === line ? answer : value))));
        const expected = [...ANSWERED];
        expected[line] = output;
        assert.deepEqual(yield* f.run(), expected);
        assert.deepEqual(yield* f.asks(), [CAPS, FACTS]);
      }).pipe(Effect.scoped),
  );

  // A server replaced between the frame's live and compat reads is refused by the frame. The
  // probe's own compat check must take that failure, not ask the replacement afresh.
  it.effect.each([
    "compat ok compatible 2 inst-1",
    "compat ok compatible 1 -",
    "compat fail changed",
    "compat fail unavailable",
  ])("%s is that question's failure for this probe and is not recorded", (answer) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.supporting();
      yield* f.write("frame", frame([...GOOD.slice(0, 3), answer]));
      assert.deepEqual(yield* f.run(), [...ANSWERED.slice(0, 3), "compat-failed"]);
      assert.deepEqual(yield* f.asks(), [CAPS, FACTS]);
      assert.notInclude(yield* f.facts(), "compat." + version + ".exe");
    }).pipe(Effect.scoped),
  );

  it.effect("a compat failure in the frame outranks an earlier recorded compat answer", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      // An earlier probe recorded compat for this server, then the manifest answers were lost.
      yield* f.run();
      assert.equal((yield* f.fact("compat." + version + ".exe")).split("\n")[1], COMPAT);
      yield* f.forgetManifest();
      yield* f.write("caps.sh", "printf 'caps v1 facts\\n'");
      yield* f.write("caps-status", "0");
      yield* Effect.promise(() =>
        NodeFSP.rm(NodePath.join(f.home, ".goat/ssh-launch/facts/caps." + version + ".exe")),
      );
      yield* f.write("frame", frame([...GOOD.slice(0, 3), "compat fail changed"]));
      assert.deepEqual(yield* f.run(), [...ANSWERED.slice(0, 3), "compat-failed"]);
    }).pipe(Effect.scoped),
  );

  it.effect.each(["live ok live " + version + " 1 1 4242", "live fail error"])(
    "%s is not recorded and live and compat are asked by their own calls",
    (answer) =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.supporting();
        yield* f.write("frame", frame([GOOD[0]!, GOOD[1]!, answer]));
        assert.deepEqual(yield* f.run(), ANSWERED);
        assert.deepEqual(yield* f.asks(), [CAPS, FACTS, LIVE_ASK, COMPAT_ASK]);
      }).pipe(Effect.scoped),
  );

  // The live key names the record's process, not an external or historical listener on its port,
  // which can be replaced without changing the key: such an answer is asked again where it is used.
  it.effect("an unbound live answer is never reused, even within the probe", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.supporting();
      const unbound = "live " + version + " 1 1 0 4343";
      yield* f.write("frame", frame([GOOD[0]!, GOOD[1]!, "live ok " + unbound, GOOD[3]!]));
      // By the time the probe's own check runs, another listener answers on that port.
      const replaced = "live 9.9.9 1 1 0 4343";
      yield* f.write("live", replaced + "\n");
      yield* f.write("compat", "client-too-old 1 inst-2\n");
      const tail = TAIL.replace(" 4242 ||", " 0 ||");
      assert.deepEqual(yield* f.run(tail), [
        ...ANSWERED.slice(0, 2),
        replaced,
        "client-too-old 1 inst-2",
      ]);
      assert.deepEqual(yield* f.asks(), [CAPS, FACTS, LIVE_ASK, COMPAT_ASK]);
      assert.deepEqual(
        yield* f.facts(),
        ["caps", "commit", "own", "version"].map((kind) => kind + "." + version + ".exe"),
      );
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a server record that changes during the call keeps live and compat to their own calls",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.supporting();
        yield* f.write(
          "facts.sh",
          "printf '%s' '" +
            JSON.stringify({ pid: 4242, port: 4343, startedAt: "2026-11-10T00:00:01.000Z" }) +
            '\' > "$HOME/.goat/userdata/server-runtime.json"; ' +
            ANSWER_FRAME,
        );
        assert.deepEqual(yield* f.run(), ANSWERED);
        assert.deepEqual(yield* f.asks(), [CAPS, FACTS, LIVE_ASK, COMPAT_ASK]);
      }).pipe(Effect.scoped),
  );

  it.effect("with no server the probe keeps the no-server answer for its later checks", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.supporting();
      yield* Effect.promise(() => NodeFSP.rm(f.record));
      const none = "none unknown unknown unknown 0 0";
      yield* f.write("frame", frame([GOOD[0]!, GOOD[1]!, "live ok " + none]));
      const answered = yield* f.run(TAIL.split("\n").slice(0, 3).join("\n"));
      assert.deepEqual(answered, [...ANSWERED.slice(0, 2), none]);
      assert.deepEqual(yield* f.asks(), [CAPS, FACTS]);
    }).pipe(Effect.scoped),
  );

  it.effect("a recorded capability answer must parse, and goes with its removed version", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const valid = [
        "caps v1",
        "caps v1 facts",
        "caps v1 pick-port-protocol facts wait-ready-report",
      ];
      const invalid = [
        "caps v1 ",
        "caps v2",
        "caps v1 facts facts",
        "caps v1 bogus",
        "caps v1  facts",
        "caps",
      ];
      const checks = [...valid, ...invalid]
        .map((value) => "if fact_valid caps '" + value + "'; then echo yes; else echo no; fi")
        .join("\n");
      assert.deepEqual(yield* f.run(checks), [
        ...valid.map(() => "yes"),
        ...invalid.map(() => "no"),
      ]);
      yield* Effect.promise(async () => {
        const facts = NodePath.join(f.home, ".goat/ssh-launch/facts");
        await NodeFSP.mkdir(facts, { recursive: true });
        await NodeFSP.writeFile(NodePath.join(facts, "caps.9.9.9.exe"), "key\ncaps v1\n");
        await NodeFSP.writeFile(NodePath.join(facts, "caps." + version + ".exe"), "key\ncaps v1\n");
      });
      yield* f.run("prune_removed_facts");
      assert.deepEqual(yield* f.facts(), ["caps." + version + ".exe"]);
    }).pipe(Effect.scoped),
  );
});
