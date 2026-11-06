// @effect-diagnostics nodeBuiltinImport:off effectFnOpportunity:off - Git integration test fixture.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";
import { makeTempDir } from "./fileFixtures.ts";
import { runGit, initRepo } from "./gitRepository.ts";

export const signatureOutputRegression = <E, R>(
  run: (
    cwd: string,
    capture: (instructions: string | undefined) => void,
  ) => Effect.Effect<void, E, R>,
) =>
  Effect.gen(function* () {
    const repoDir = yield* makeTempDir("goat-git-manager-");
    yield* initRepo(repoDir);
    const signingKey = NodePath.join(yield* makeTempDir("goat-git-signing-key-"), "key");
    NodeChildProcess.execFileSync("ssh-keygen", [
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-f",
      signingKey,
    ]);
    yield* runGit(repoDir, ["config", "gpg.format", "ssh"]);
    yield* runGit(repoDir, ["config", "gpg.ssh.program", "ssh-keygen"]);
    yield* runGit(repoDir, ["config", "user.signingkey", `${signingKey}.pub`]);
    yield* runGit(repoDir, ["config", "log.showSignature", "true"]);
    yield* runGit(repoDir, ["commit", "--amend", "-S", "--no-edit"]);
    NodeFS.writeFileSync(NodePath.join(repoDir, "README.md"), "hello again\n");
    let instructions: string | undefined;
    yield* run(repoDir, (value) => {
      instructions = value;
    });
    expect(instructions).toMatch(/Recent commit subjects from this repository:\nInitial commit$/);
  });
