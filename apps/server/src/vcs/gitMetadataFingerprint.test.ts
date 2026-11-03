import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { git, initRepoWithCommit, layerTest, makeTmpDir } from "./testing/gitFixture.ts";
import { makeGitMetadataFingerprint } from "./gitMetadataFingerprint.ts";

const setup = Effect.gen(function* () {
  const cwd = yield* makeTmpDir();
  yield* initRepoWithCommit(cwd);
  yield* git(cwd, ["remote", "add", "origin", "https://github.com/example/project.git"]);
  yield* git(cwd, ["config", "branch.main.remote", "origin"]);
  yield* git(cwd, ["config", "branch.other.remote", "origin"]);
  const fs = yield* FileSystem.FileSystem;
  const configPath = (yield* Path.Path).join(cwd, ".git", "config");
  const append = (text: string) =>
    Effect.flatMap(fs.readFileString(configPath), (current) =>
      fs.writeFileString(configPath, current + text),
    );
  const read = yield* makeGitMetadataFingerprint();
  const fingerprint = (branch?: string) =>
    Effect.flatMap(read(cwd, branch), (value) =>
      value === null ? Effect.die("expected a git fingerprint") : Effect.succeed(value),
    );
  return { cwd, append, fingerprint };
});

it.effect("another branch's config section leaves a branch's fingerprint unchanged", () =>
  Effect.gen(function* () {
    const { cwd, fingerprint } = yield* setup;
    const before = yield* fingerprint("main");
    // "other" is the file's last section, so a new section lands right after it.
    const lastBefore = yield* fingerprint("other");
    yield* git(cwd, ["config", "branch.other.merge", "refs/heads/other"]);
    yield* git(cwd, ["config", "branch.third.remote", "origin"]);
    assert.deepEqual(yield* fingerprint("main"), before);
    yield* git(cwd, ["config", "branch.fourth.remote", "origin"]);
    assert.equal((yield* fingerprint("other")).repository, lastBefore.repository);
    // Whole-repository readers still see every change.
    const whole = yield* fingerprint();
    yield* git(cwd, ["config", "branch.other.merge", "refs/heads/elsewhere"]);
    assert.notEqual((yield* fingerprint()).repository, whole.repository);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("a branch's own section moves only its refs part, whatever the keyword case", () =>
  Effect.gen(function* () {
    const { cwd, append, fingerprint } = yield* setup;
    const before = yield* fingerprint("main");
    yield* append('[Branch "main"]\n\tdescription = renamed\n');
    const after = yield* fingerprint("main");
    assert.equal(after.repository, before.repository);
    assert.notEqual(after.refs, before.refs);
    // Branch names are one repository fact: alternating lookups agree on it.
    assert.equal((yield* fingerprint("other")).repository, after.repository);
    yield* git(cwd, ["config", "branch.main.merge", "refs/heads/main"]);
    assert.notEqual((yield* fingerprint("main")).refs, after.refs);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("shared sections, legacy headers and sections after a branch stay shared", () =>
  Effect.gen(function* () {
    const { cwd, append, fingerprint } = yield* setup;
    let previous = (yield* fingerprint("main")).repository;
    const expectRepositoryChange = Effect.gen(function* () {
      const next = (yield* fingerprint("main")).repository;
      assert.notEqual(next, previous);
      previous = next;
    });
    yield* git(cwd, ["remote", "set-url", "origin", "https://github.com/example/moved.git"]);
    yield* expectRepositoryChange;
    yield* append("[branch.other]\n\tremote = origin\n");
    yield* expectRepositoryChange;
    yield* append('[branch "other"]\n\tremote = origin\n[remote "upstream"]\n\turl = a\n');
    yield* expectRepositoryChange;
    yield* git(cwd, ["config", "remote.upstream.url", "b"]);
    yield* expectRepositoryChange;
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect.each([
  { label: "LF", newline: "\n" },
  { label: "CRLF", newline: "\r\n" },
])("a continued value falls back to the whole config file ($label)", ({ newline }) =>
  Effect.gen(function* () {
    const { cwd, append, fingerprint } = yield* setup;
    // The second line belongs to the value, so it must not end the [core] section.
    yield* append(`[core]${newline}\tcomment = first \\${newline}[branch "other"]${newline}`);
    const before = yield* fingerprint("main");
    yield* git(cwd, ["config", "branch.other.merge", "refs/heads/other"]);
    assert.notEqual((yield* fingerprint("main")).repository, before.repository);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);
