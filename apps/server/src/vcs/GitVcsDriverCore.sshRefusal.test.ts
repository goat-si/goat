import { assert, it } from "@effect/vitest";
import { refuseSshHostsScoped } from "@goat/ssh/hostAccess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as GitVcsDriver from "./GitVcsDriver.ts";
import {
  git,
  initRepoWithCommit,
  layerTest,
  makeTmpDir,
  writeTextFile,
} from "./testing/gitFixture.ts";

it.layer(layerTest)("GitVcsDriver with SSH refused", (it) => {
  it.effect("regression: a background upstream fetch spawns no ssh while SSH is refused", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const tempDir = yield* makeTmpDir("git-vcs-driver-ssh-refused-");
      const fakeSsh = pathService.join(tempDir, "fake-ssh");
      yield* writeTextFile(tempDir, "fake-ssh", '#!/bin/sh\necho "$@" >> "$0.log"\nexit 255\n');
      yield* fileSystem.chmod(fakeSsh, 0o755);
      const sshRemoteRepo = Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["remote", "add", "origin", "ssh://example.invalid/repo.git"]);
        yield* git(cwd, ["update-ref", `refs/remotes/origin/${initialBranch}`, "HEAD"]);
        yield* git(cwd, ["branch", "--set-upstream-to", `origin/${initialBranch}`]);
        // Git runs this through sh, which would eat the backslashes of a bare Windows path.
        yield* git(cwd, ["config", "core.sshCommand", `'${fakeSsh}'`]);
        return cwd;
      });
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const sshLog = `${fakeSsh}.log`;

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* refuseSshHostsScoped();
          yield* driver.statusDetails(yield* sshRemoteRepo);
        }),
      );
      assert.isFalse(yield* fileSystem.exists(sshLog));

      yield* driver.statusDetails(yield* sshRemoteRepo);
      assert.include(yield* fileSystem.readFileString(sshLog), "example.invalid");
    }),
  );
});
