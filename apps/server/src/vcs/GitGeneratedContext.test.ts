import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import {
  layerTest,
  makeTmpDir,
  writeTextFile,
  git,
  initRepoWithCommit,
} from "./testing/gitFixture.ts";

it.layer(layerTest)("Git generated context", (it) => {
  it.effect("reads raw range context regardless of Git display configuration", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      yield* git(cwd, ["config", "diff.probe.textconv", "touch textconv-ran; echo converted"]);
      yield* git(cwd, ["config", "color.ui", "always"]);
      yield* git(cwd, ["config", "diff.relative", "true"]);
      yield* git(cwd, ["config", "log.decorate", "short"]);
      yield* git(cwd, ["checkout", "-b", "feature/range"]);
      yield* writeTextFile(cwd, ".gitattributes", "*.doc diff=probe\n");
      yield* writeTextFile(cwd, "notes.doc", "source line\n");
      yield* writeTextFile(cwd, "plain.txt", "plain line\n");
      yield* writeTextFile(cwd, "binary.dat", "binary\0data");
      yield* git(cwd, ["add", "."]);
      const signingKey = `${yield* makeTmpDir("git-vcs-driver-signing-key-")}/key`;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const keygen = ChildProcess.make("ssh-keygen", [
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-f",
        signingKey,
      ]);
      assert.equal(Number(yield* spawner.exitCode(keygen)), 0);
      yield* git(cwd, ["config", "gpg.format", "ssh"]);
      // A global signer such as 1Password's cannot use the fixture's generated key.
      yield* git(cwd, ["config", "gpg.ssh.program", "ssh-keygen"]);
      yield* git(cwd, ["config", "user.signingkey", `${signingKey}.pub`]);
      yield* git(cwd, ["config", "log.showSignature", "true"]);
      yield* git(cwd, ["commit", "-S", "-m", "range files"]);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const fileSystem = yield* FileSystem.FileSystem;
      const projectCwd = `${cwd}/app`;
      yield* fileSystem.makeDirectory(projectCwd);

      const context = yield* driver.readRangeContext(projectCwd, initialBranch);

      assert.match(context.commitSummary.trim(), /^[a-f0-9]+ range files$/);
      assert.include(context.diffPatch, "+source line");
      assert.notInclude(context.diffPatch, "converted");
      assert.include(context.diffPatch, "+plain line");
      assert.include(context.diffPatch, "Binary files /dev/null and b/binary.dat differ");
      assert.include(context.diffSummary, "notes.doc");
      for (const output of [context.commitSummary, context.diffSummary, context.diffPatch]) {
        assert.notInclude(output, "\u001b[");
      }
      assert.isFalse(yield* fileSystem.exists(`${cwd}/textconv-ran`));

      yield* writeTextFile(cwd, "notes.doc", "updated source line\n");
      const staged = yield* driver.prepareCommitContext(projectCwd, ["notes.doc"]);
      assert.include(staged?.stagedPatch ?? "", "+updated source line");
      assert.notInclude(staged?.stagedPatch ?? "", "converted");
      assert.notInclude(staged?.stagedPatch ?? "", "\u001b[");
      assert.include(staged?.stagedSummary ?? "", "notes.doc");
      assert.isFalse(yield* fileSystem.exists(`${cwd}/textconv-ran`));
    }),
  );
});
