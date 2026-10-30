import { assert, it } from "@effect/vitest";
import { allowSshHosts } from "@goat/ssh/hostAccess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { applyDevSshPolicy } from "../devSshPolicy.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import {
  git,
  initRepoWithCommit,
  layerTest,
  makeTmpDir,
  writeTextFile,
} from "./testing/gitFixture.ts";

// The policy writes the server's own environment, which every git child inherits.
const refusedDevServer = Effect.acquireRelease(
  Effect.sync(() => process.env.GIT_SSH_COMMAND).pipe(
    Effect.tap(() => applyDevSshPolicy({ devUrl: new URL("http://localhost:5733") }, process.env)),
  ),
  (previous) =>
    allowSshHosts.pipe(
      Effect.andThen(
        Effect.sync(() => {
          if (previous === undefined) delete process.env.GIT_SSH_COMMAND;
          else process.env.GIT_SSH_COMMAND = previous;
        }),
      ),
    ),
);

it.layer(layerTest)("git on a dev server that refuses SSH", (it) => {
  it.effect("regression: no git the server runs reaches an SSH remote", () =>
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

      const refused = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* refusedDevServer;
          const cwd = yield* sshRemoteRepo;
          // Background status refresh, then an arbitrary remote command such as cleanup's ls-remote.
          yield* driver.statusDetails(cwd);
          return yield* driver
            .execute({ operation: "test.lsRemote", cwd, args: ["ls-remote", "origin"] })
            .pipe(Effect.flip);
        }),
      );
      assert.isFalse(yield* fileSystem.exists(sshLog));
      assert.equal(refused.reason, "remote_unreachable");

      yield* driver.statusDetails(yield* sshRemoteRepo);
      assert.include(yield* fileSystem.readFileString(sshLog), "example.invalid");
    }),
  );
});
