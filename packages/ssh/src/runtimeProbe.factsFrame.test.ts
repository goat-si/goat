// @effect-diagnostics nodeBuiltinImport:off - runs the real generated probe script against a temporary home.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { it } from "@effect/vitest";
import { assert, describe } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { OLD_HELPER_CAPS_STDERR } from "./runtimeFactsScripts.ts";
import {
  version,
  LIVE,
  COMPAT,
  frame,
  GOOD,
  CAPS,
  FACTS,
  MANIFEST_ASK,
  LIVE_ASK,
  COMPAT_ASK,
  SEPARATE,
  ANSWER_CAPS,
  ANSWER_FRAME,
  REPLACE_SELF,
  TAIL,
  ANSWERED,
  fixture,
} from "./runtimeProbe.frame.fixture.ts";

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

  it.effect.each([
    { line: 3, answer: "compat fail changed", output: "compat-failed" },
    { line: 2, answer: "live fail error", output: "live-failed" },
    { line: 2, answer: "live ok live " + version + " 1 1 4242", output: "live-failed" },
    { line: 1, answer: "commit fail unavailable", output: "no-commit" },
    { line: 1, answer: "commit ok 0", output: "no-commit" },
  ])("$answer in the frame outranks an earlier recorded answer", ({ line, answer, output }) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      // An earlier probe recorded every answer for this server, then the manifest answers were lost.
      yield* f.run();
      assert.equal((yield* f.fact("compat." + version + ".exe")).split("\n")[1], COMPAT);
      yield* f.forgetManifest();
      yield* f.write("caps.sh", "printf 'caps v1 facts\\n'");
      yield* f.write("caps-status", "0");
      yield* Effect.promise(() =>
        NodeFSP.rm(NodePath.join(f.home, ".goat/ssh-launch/facts/caps." + version + ".exe")),
      );
      // A failed live question leaves no compat line in the frame; the recorded compat stands.
      const lines = GOOD.map((value, at) => (at === line ? answer : value));
      yield* f.write("frame", frame(line === 2 ? lines.slice(0, 3) : lines));
      const expected = [...ANSWERED];
      expected[line] = output;
      assert.deepEqual(yield* f.run(), expected);
    }).pipe(Effect.scoped),
  );

  it.effect.each(["live ok live " + version + " 1 1 4242", "live fail error"])(
    "%s is the live question's failure for this probe and is not recorded",
    (answer) =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.supporting();
        yield* f.write("frame", frame([GOOD[0]!, GOOD[1]!, answer]));
        // The frame has no compat line without a live server; compat is asked by its own call.
        assert.deepEqual(yield* f.run(), [...ANSWERED.slice(0, 2), "live-failed", COMPAT]);
        assert.deepEqual(yield* f.asks(), [CAPS, FACTS, COMPAT_ASK]);
        assert.notInclude(yield* f.facts(), "live." + version + ".exe");
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

  // A record GOAT cannot key (here, no PID) names inputs that can change without any key noticing.
  it.effect.each([
    { name: "live", lines: [GOOD[0]!, GOOD[1]!, "live fail error"] },
    { name: "compat", lines: [...GOOD.slice(0, 3), "compat fail changed"] },
  ])("a $name failure read without a live key is asked again by its own call", ({ lines }) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.supporting();
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          f.record,
          JSON.stringify({ port: 4343, startedAt: "2026-11-10T00:00:00.000Z" }),
        ),
      );
      yield* f.write("frame", frame(lines));
      assert.deepEqual(yield* f.run(), ANSWERED);
      assert.deepEqual(yield* f.asks(), [CAPS, FACTS, LIVE_ASK, COMPAT_ASK]);
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    { name: "while the files stay absent", appear: false },
    { name: "unless a launch file appears", appear: true },
  ])("a live failure with no server files holds $name", ({ appear }) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.supporting();
      yield* Effect.promise(() => NodeFSP.rm(f.record));
      yield* f.write("frame", frame([GOOD[0]!, GOOD[1]!, "live fail error"]));
      const tail = [
        ...TAIL.split("\n").slice(0, 2),
        appear ? 'mkdir -p "$state"; printf \'4343\\n\' > "$state/port"' : ":",
        TAIL.split("\n")[2]!,
      ].join("\n");
      assert.deepEqual(yield* f.run(tail), [
        ...ANSWERED.slice(0, 2),
        appear ? LIVE : "live-failed",
      ]);
      assert.deepEqual(yield* f.asks(), appear ? [CAPS, FACTS, LIVE_ASK] : [CAPS, FACTS]);
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
