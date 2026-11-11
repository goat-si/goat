// @effect-diagnostics nodeBuiltinImport:off - runs the real generated probe script against a temporary home.
import * as NodeFSP from "node:fs/promises";
import { it } from "@effect/vitest";
import { assert, describe } from "vite-plus/test";
import * as Effect from "effect/Effect";
import {
  ANSWER_FRAMES,
  ANSWERED,
  COMPAT,
  LIVE,
  fixture,
  version,
} from "./runtimeProbe.frame.fixture.ts";

const EXE = "HOME/.goat/runtime/goat/versions/" + version + "/goat";
const INVALID = JSON.stringify({ serverVersion: version, invalid: true });
const DIR = '"$HOME/.goat/runtime/goat/versions/' + version + '"';
const OTHER_HASH = "b".repeat(64);

describe("the first probe's goat.exe manifest check", () => {
  it.effect.each([
    { name: "one combined start", supporting: true },
    { name: "separate calls", supporting: false },
  ])("an unchanged executable is hashed once per first probe ($name)", ({ supporting }) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      if (supporting) yield* f.supporting();
      assert.deepEqual(yield* f.run(), ANSWERED);
      assert.deepEqual(yield* f.digests(), [EXE]);
    }).pipe(Effect.scoped),
  );

  // An old enough replacement keeps the keys taken after the hash equal, while the install
  // record still names the bytes that were hashed: only the key taken before the hash sees it.
  it.effect("an executable replaced between its hash and the key after it is hashed again", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.supporting();
      yield* f.write("digest-hook", "printf '\\n# replaced\\n' >> \"$3\"");
      assert.deepEqual(yield* f.run(), [INVALID, ...ANSWERED.slice(1)]);
      assert.deepEqual(yield* f.digests(), [EXE, EXE]);
      const stored = yield* f.facts();
      assert.notInclude(stored, "version." + version + ".exe");
      assert.notInclude(stored, "own." + version + ".exe");
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    {
      name: "a marker and record naming other bytes",
      change:
        "printf '%s %s\\n' " +
        version +
        " " +
        OTHER_HASH +
        " > " +
        DIR +
        "/goat-manifest-shell-v1.sha256; " +
        "printf '%s %s %s cache\\n' " +
        version +
        " " +
        "a".repeat(64) +
        " " +
        OTHER_HASH +
        " > " +
        DIR +
        "/.install-record",
    },
    { name: "a removed marker", change: "rm " + DIR + "/goat-manifest-shell-v1.sha256" },
    { name: "a removed install record", change: "rm " + DIR + "/.install-record" },
    {
      name: "a marker made a link to the same text",
      change:
        "mv " +
        DIR +
        '/goat-manifest-shell-v1.sha256 "$HOME/marker-copy"; ' +
        'ln -s "$HOME/marker-copy" ' +
        DIR +
        "/goat-manifest-shell-v1.sha256",
    },
    {
      name: "an install record made a link to the same text",
      change:
        "mv " +
        DIR +
        '/.install-record "$HOME/record-copy"; ' +
        'ln -s "$HOME/record-copy" ' +
        DIR +
        "/.install-record",
    },
  ])("$name during the call refuses the manifest", ({ change }) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.supporting();
      yield* f.write("facts.sh", change + "; " + ANSWER_FRAMES);
      const answered = yield* f.run();
      assert.equal(answered[0], INVALID);
      const stored = yield* f.facts();
      assert.notInclude(stored, "version." + version + ".exe");
      assert.notInclude(stored, "own." + version + ".exe");
    }).pipe(Effect.scoped),
  );

  it.effect("an executable too young to key is hashed again after the call, as before", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.supporting();
      const changed = Math.floor((yield* Effect.promise(() => NodeFSP.stat(f.exe))).ctimeMs / 1000);
      yield* f.write("now", String(changed + 1) + "\n");
      const answered = yield* f.run();
      assert.deepEqual(answered, ANSWERED);
      assert.deepEqual(yield* f.digests(), [EXE, EXE]);
      assert.deepEqual([LIVE, COMPAT], answered.slice(2));
    }).pipe(Effect.scoped),
  );
});
