// @effect-diagnostics nodeBuiltinImport:off - runs the real generated probe script against a temporary home.
import { it } from "@effect/vitest";
import { assert, describe } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { OLD_HELPER_CAPS_STDERR } from "./runtimeFactsScripts.ts";
import {
  ANSWERED,
  CAPS,
  DIRECT,
  FACTS,
  GOOD,
  REPLACE_SELF,
  SEPARATE,
  directFrame,
  fixture,
  frame,
  version,
} from "./runtimeProbe.frame.fixture.ts";

const ALL = ["commit", "compat", "live", "own", "version"].map(
  (kind) => kind + "." + version + ".exe",
);
const WITH_CAPS = ["caps", "commit", "compat", "live", "own", "version"].map(
  (kind) => kind + "." + version + ".exe",
);
const INVALID = JSON.stringify({ serverVersion: version, invalid: true });
const EXE = '"$HOME/.goat/runtime/goat/versions/' + version + '/goat"';
// What the direct frame says for commit when the test must tell its answers from the lookup's.
const DIRECT_ONLY = GOOD.map((line) =>
  line.startsWith("commit ") ? "commit ok 1600000000" : line,
);
const onDirect = (script: string) =>
  'case "$*" in *--with-caps*) ' + script + ' ;; *) cat "$HOME/frame" ;; esac';

describe("the first probe asks the client's own runtime for its facts directly", () => {
  // The separate capability lookup is never asked, so its answer cannot matter, and the frame's own
  // capability line is evidence for this script only: it is not recorded.
  it.effect.each([
    { name: "denies facts", status: "1", err: OLD_HELPER_CAPS_STDERR, out: "usage\n" },
    { name: "fails", status: "2", err: "boom\n", out: "" },
    { name: "lists facts", status: "0", err: "", out: "caps v1 facts\n" },
  ])("one start answers every question while capabilities $name", ({ status, err, out }) =>
    Effect.gen(function* () {
      const f = yield* fixture({ own: version });
      yield* f.write("caps-status", status);
      yield* f.write("caps-err", err);
      yield* f.write("caps-out", out);
      assert.deepEqual(yield* f.run(), ANSWERED);
      assert.deepEqual(yield* f.asks(), [DIRECT]);
      assert.deepEqual(yield* f.facts(), ALL);
      // The next probe finds every answer recorded.
      assert.deepEqual(yield* f.run(), ANSWERED);
      assert.deepEqual(yield* f.asks(), [DIRECT]);
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    {
      name: "an unbound live server",
      lines: [GOOD[0]!, GOOD[1]!, "live ok live " + version + " 1 1 0 4343", GOOD[3]!],
      stored: ["commit", "own", "version"],
    },
    {
      name: "no commit time",
      lines: [GOOD[0]!, "commit fail unavailable", GOOD[2]!, GOOD[3]!],
      stored: ["compat", "live", "own", "version"],
    },
    {
      name: "a failed manifest",
      lines: ["manifest fail error", ...GOOD.slice(1)],
      stored: ["commit", "compat", "live"],
    },
  ])("with $name each answer is stored only under its own rule", ({ lines, stored }) =>
    Effect.gen(function* () {
      const f = yield* fixture({ own: version });
      yield* f.write("frame-direct", directFrame(lines));
      yield* f.run('binary_json "$V" >/dev/null || :');
      assert.deepEqual(yield* f.asks(), [DIRECT]);
      assert.deepEqual(
        yield* f.facts(),
        stored.map((kind) => kind + "." + version + ".exe"),
      );
    }).pipe(Effect.scoped),
  );

  // Each is a failed direct attempt: nothing it said is stored or marks the frame asked, and the
  // probe takes today's path, whose lookup and combined call store their own answers.
  it.effect.each([
    { name: "has no capability line", text: frame(DIRECT_ONLY) },
    { name: "has a capability line without facts", text: directFrame(DIRECT_ONLY, "caps v1") },
    { name: "has a malformed capability line", text: directFrame(DIRECT_ONLY, "caps v1 bogus") },
    {
      name: "repeats the capability line",
      text: directFrame(["caps v1 facts", ...DIRECT_ONLY]).replace("end 5", "end 4"),
    },
    {
      name: "has the capability line third",
      text: [
        "begin v1 facts",
        DIRECT_ONLY[0],
        "caps v1 facts",
        ...DIRECT_ONLY.slice(1),
        "end 4",
        "",
      ].join("\n"),
    },
    {
      name: "counts the capability line",
      text: directFrame(DIRECT_ONLY).replace("end 4", "end 5"),
    },
    { name: "is cut short", text: directFrame(DIRECT_ONLY).replace("\nend 4\n", "\n") },
    { name: "writes to stderr", text: directFrame(DIRECT_ONLY), script: "printf 'warning\\n' >&2" },
    { name: "exits nonzero", text: directFrame(DIRECT_ONLY), script: "exit 3" },
  ])("a direct frame that $name falls back to the capability lookup", ({ text, script }) =>
    Effect.gen(function* () {
      const f = yield* fixture({ own: version });
      yield* f.supporting();
      yield* f.write("frame-direct", text);
      if (script !== undefined)
        yield* f.write("facts.sh", onDirect('cat "$HOME/frame-direct"; ' + script));
      assert.deepEqual(yield* f.run(), ANSWERED);
      assert.deepEqual(yield* f.asks(), [DIRECT, CAPS, FACTS]);
      assert.deepEqual(yield* f.facts(), WITH_CAPS);
      assert.equal((yield* f.fact("caps." + version + ".exe")).split("\n")[1], "caps v1 facts");
      assert.equal((yield* f.fact("commit." + version + ".exe")).split("\n")[1], "1700000000");
    }).pipe(Effect.scoped),
  );

  // A runtime that floods stderr cannot fill the host's disk: the capture keeps one byte.
  it.effect("a direct call's stderr is captured only as far as needed to refuse it", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ own: version });
      yield* f.supporting();
      yield* f.write(
        "facts.sh",
        onDirect('cat "$HOME/frame-direct"; head -c 300000 /dev/zero | tr "\\\\0" x >&2'),
      );
      const tail =
        "facts_frame_ask " + EXE + ' >/dev/null 2>&1 || :\nwc -c <"$FACT_MEMO.facts-err"';
      assert.deepEqual(
        (yield* f.run(tail)).map((line) => line.trim()),
        ["1"],
      );
      assert.deepEqual(yield* f.asks(), [DIRECT, CAPS, FACTS]);
    }).pipe(Effect.scoped),
  );

  it.effect("an executable replaced during the direct call leaves nothing from that call", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ own: version });
      yield* f.supporting();
      yield* f.write("frame-direct", directFrame(DIRECT_ONLY));
      yield* f.write("facts.sh", onDirect(REPLACE_SELF + 'cat "$HOME/frame-direct"'));
      assert.deepEqual(yield* f.run(), [INVALID, ...ANSWERED.slice(1)]);
      assert.deepEqual(yield* f.asks(), [DIRECT, CAPS, FACTS, ...SEPARATE]);
      const stored = yield* f.facts();
      assert.notInclude(stored, "version." + version + ".exe");
      assert.notInclude(stored, "own." + version + ".exe");
      assert.equal((yield* f.fact("commit." + version + ".exe")).split("\n")[1], "1700000000");
    }).pipe(Effect.scoped),
  );

  it.effect("a runtime that lists facts but cannot answer them runs the separate calls", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ own: version });
      yield* f.supporting();
      yield* f.write("facts.sh", "exit 3");
      assert.deepEqual(yield* f.run(), ANSWERED);
      assert.deepEqual(yield* f.asks(), [DIRECT, CAPS, FACTS, ...SEPARATE]);
      assert.equal((yield* f.fact("caps." + version + ".exe")).split("\n")[1], "caps v1 facts");
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    { name: "lists facts", supporting: true, asks: [FACTS] },
    { name: "denies facts", supporting: false, asks: SEPARATE },
  ])(
    "a recorded capability answer that $name is honored without a direct call",
    ({ supporting, asks }) =>
      Effect.gen(function* () {
        const f = yield* fixture({ own: version });
        if (supporting) yield* f.supporting();
        yield* f.run("helper_caps " + EXE);
        assert.deepEqual(yield* f.asks(), [CAPS]);
        assert.deepEqual(yield* f.run(), ANSWERED);
        assert.deepEqual(yield* f.asks(), [CAPS, ...asks]);
      }).pipe(Effect.scoped),
  );

  it.effect.each([
    { name: "another version", own: "9.9.9" },
    { name: "no version", own: undefined },
  ])("a client that names $name as its own asks capabilities first", ({ own }) =>
    Effect.gen(function* () {
      const f = yield* fixture(own === undefined ? {} : { own });
      yield* f.supporting();
      assert.deepEqual(yield* f.run(), ANSWERED);
      assert.deepEqual(yield* f.asks(), [CAPS, FACTS]);
    }).pipe(Effect.scoped),
  );

  // A runtime asked without --with-caps prints no capability line; one that did is still read.
  it.effect("a combined frame carrying the capability line is used after a lookup", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.supporting();
      yield* f.write("frame", directFrame(GOOD));
      assert.deepEqual(yield* f.run(), ANSWERED);
      assert.deepEqual(yield* f.asks(), [CAPS, FACTS]);
      assert.deepEqual(yield* f.facts(), WITH_CAPS);
    }).pipe(Effect.scoped),
  );
});
