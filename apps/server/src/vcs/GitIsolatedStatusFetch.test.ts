// @effect-diagnostics nodeBuiltinImport:off - this fixture cuts a Git upload pack transfer.
import * as NodeFS from "node:fs";
import * as HostProcess from "@goat/shared/HostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { layerTest, makeTmpDir, git, initRepoWithCommit } from "./testing/gitFixture.ts";

it.layer(layerTest)("isolated status fetch", (it) => {
  // Cutting a transfer short takes a shell `upload-pack` wrapper.
  describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "background upstream fetch objects",
    () => {
      it.effect.each([
        { transfer: "cut short", unpackLimit: "1", behindCount: 0 },
        { transfer: "complete as a pack", unpackLimit: "1", behindCount: 1 },
        { transfer: "complete as loose objects", unpackLimit: "100", behindCount: 1 },
        { transfer: "followed by a push", unpackLimit: "100", behindCount: 0 },
      ] as const)(
        "leaves only finished objects after a background upstream fetch that is $transfer",
        ({ transfer, unpackLimit, behindCount }) =>
          Effect.gen(function* () {
            const path = yield* Path.Path;
            const cwd = yield* makeTmpDir();
            const remote = yield* makeTmpDir("git-vcs-driver-remote-");
            const updater = yield* makeTmpDir("git-vcs-driver-updater-");
            const { initialBranch } = yield* initRepoWithCommit(cwd);
            yield* git(remote, ["init", "--bare"]);
            yield* git(cwd, ["remote", "add", "origin", remote]);
            yield* git(cwd, ["push", "-u", "origin", initialBranch]);

            yield* git(updater, ["clone", remote, "."]);
            yield* git(updater, ["config", "user.email", "test@test.com"]);
            yield* git(updater, ["config", "user.name", "Test"]);
            const incompressible = new Uint8Array(150_000);
            for (let index = 0, state = 1; index < incompressible.length; index++) {
              state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
              incompressible[index] = state >>> 16;
            }
            NodeFS.writeFileSync(path.join(updater, "remote.bin"), incompressible);
            yield* git(updater, ["add", "remote.bin"]);
            yield* git(updater, ["commit", "-m", "remote commit"]);
            yield* git(updater, ["push", "origin", initialBranch]);
            NodeFS.writeFileSync(path.join(updater, "pushed.bin"), incompressible.reverse());
            yield* git(updater, ["add", "pushed.bin"]);
            yield* git(updater, ["commit", "-m", "pushed between connections"]);
            yield* git(updater, ["push", "origin", "HEAD:refs/pending/push"]);

            // The first transfer is whole and the branch may move right after it. The fetch
            // that moves the refs then meets a remote its download did not see, and must not
            // point a ref at the push: nothing has put those objects in the repository.
            const served = path.join(remote, "served");
            if (transfer === "cut short") NodeFS.writeFileSync(served, "");
            const push =
              transfer === "followed by a push"
                ? `git --git-dir='${remote}' update-ref refs/heads/${initialBranch} refs/pending/push;`
                : "";
            const later =
              transfer === "followed by a push" ? "" : "| dd bs=1 count=50000 2>/dev/null";
            yield* git(cwd, [
              "config",
              "remote.origin.uploadpack",
              `f() { if [ -e '${served}' ]; then git upload-pack "$@" ${later}; else : > '${served}'; git upload-pack "$@"; ${push} fi; }; f`,
            ]);
            yield* git(cwd, ["config", "fetch.unpackLimit", unpackLimit]);
            const objects = path.join(cwd, ".git", "objects");
            NodeFS.writeFileSync(path.join(objects, "pack", "tmp_pack_other"), "another fetch");

            const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetailsRemote(cwd);

            assert.equal(status.behindCount, behindCount);
            assert.deepEqual(
              [...NodeFS.readdirSync(objects), ...NodeFS.readdirSync(path.join(objects, "pack"))]
                .filter((name) => name.startsWith("tmp_"))
                .toSorted(),
              ["tmp_pack_other"],
            );
          }),
      );
    },
  );
});
