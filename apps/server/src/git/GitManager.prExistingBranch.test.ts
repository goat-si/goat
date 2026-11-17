// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { expect } from "vite-plus/test";

import { makeTempDir } from "./testkit/fileFixtures.ts";
import { runGit, initRepo } from "./testkit/gitRepository.ts";
import {
  createBareRemote,
  layerGitManagerTest,
  makeManager,
  preparePullRequestThread,
} from "./GitManagerTestHarness.ts";

it.layer(layerGitManagerTest)("GitManager existing PR branches", (it) => {
  it.effect.each([
    { localBranch: "ahead", expectedHead: "local", isOnPullRequestHead: false },
    { localBranch: "behind", expectedHead: "pull request", isOnPullRequestHead: true },
    { localBranch: "rewritten", expectedHead: "pull request", isOnPullRequestHead: true },
    { localBranch: "rewritten-fetched", expectedHead: "pull request", isOnPullRequestHead: true },
    { localBranch: "wrong-ref", expectedHead: "pull request", isOnPullRequestHead: true },
    { localBranch: "stale-head", expectedHead: "local", isOnPullRequestHead: false },
    { localBranch: "checkout-race", expectedHead: "pull request", isOnPullRequestHead: true },
  ] as const)(
    "moves an existing PR branch into a new worktree only when nothing is lost ($localBranch)",
    ({ localBranch, expectedHead, isOnPullRequestHead }) =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("goat-git-manager-");
        yield* initRepo(repoDir);
        const remoteDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
        yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
        yield* runGit(repoDir, ["checkout", "-b", "feature/pr-existing"]);
        NodeFS.writeFileSync(NodePath.join(repoDir, "existing.txt"), "pushed\n");
        yield* runGit(repoDir, ["add", "existing.txt"]);
        yield* runGit(repoDir, ["commit", "-m", "Pushed PR commit"]);
        yield* runGit(repoDir, ["push", "-u", "origin", "feature/pr-existing"]);
        if (localBranch === "ahead") {
          NodeFS.writeFileSync(NodePath.join(repoDir, "mine.txt"), "mine\n");
          yield* runGit(repoDir, ["add", "mine.txt"]);
          yield* runGit(repoDir, ["commit", "-m", "My unpublished commit"]);
        } else if (!localBranch.startsWith("rewritten")) {
          yield* runGit(repoDir, ["checkout", "-b", "author-push"]);
          NodeFS.writeFileSync(NodePath.join(repoDir, "authored.txt"), "authored\n");
          yield* runGit(repoDir, ["add", "authored.txt"]);
          yield* runGit(repoDir, ["commit", "-m", "New PR head commit"]);
          yield* runGit(repoDir, ["push", "origin", "author-push:feature/pr-existing"]);
        } else {
          const staleHead = (yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim();
          yield* runGit(repoDir, ["checkout", "-b", "author-rewrite"]);
          NodeFS.writeFileSync(NodePath.join(repoDir, "existing.txt"), "rewritten\n");
          yield* runGit(repoDir, ["add", "existing.txt"]);
          yield* runGit(repoDir, ["commit", "--amend", "-m", "Rewritten PR head"]);
          yield* runGit(repoDir, [
            "push",
            "--force",
            "origin",
            "author-rewrite:feature/pr-existing",
          ]);
          if (localBranch === "rewritten") {
            yield* runGit(repoDir, [
              "update-ref",
              "refs/remotes/origin/feature/pr-existing",
              staleHead,
            ]);
          }
        }
        const localHead = (yield* runGit(repoDir, [
          "rev-parse",
          "feature/pr-existing",
        ])).stdout.trim();
        const pullHead = (yield* runGit(repoDir, [
          "ls-remote",
          "origin",
          "refs/heads/feature/pr-existing",
        ])).stdout.split("\t")[0];
        yield* runGit(repoDir, ["checkout", "main"]);

        if (localBranch === "wrong-ref") {
          yield* runGit(repoDir, ["push", "origin", "main:refs/pull/88/head"]);
        }
        const gate = {
          matches: (args: ReadonlyArray<string>) =>
            args[0] === "fetch" &&
            args.some((arg) => arg.startsWith("+refs/heads/feature/pr-existing:")),
          reached: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        const { manager } = yield* makeManager({
          ...(localBranch === "checkout-race" ? { gitSpawnGate: gate } : {}),
          providerScenario: {
            pullRequest: {
              number: 88,
              title: "Existing branch PR",
              url: "https://github.com/pingdotgg/codething-mvp/pull/88",
              baseRefName: "main",
              headRefName: "feature/pr-existing",
              state: "open",
              headSha: localBranch === "stale-head" ? localHead : pullHead,
              isCrossRepository: false,
              headRepositoryNameWithOwner: "pingdotgg/codething-mvp",
              headRepositoryOwnerLogin: "pingdotgg",
            },
            repositoryCloneUrls: {
              "pingdotgg/codething-mvp": { url: remoteDir, sshUrl: remoteDir },
            },
          },
        });

        const preparing = yield* Effect.forkChild(
          preparePullRequestThread(manager, {
            cwd: repoDir,
            reference: "88",
            mode: "worktree",
          }),
        );
        if (localBranch === "checkout-race") {
          yield* Deferred.await(gate.reached);
          const checkout = yield* runGit(repoDir, ["checkout", "feature/pr-existing"], true);
          yield* Deferred.succeed(gate.release, undefined);
          expect(checkout.exitCode).not.toBe(0);
          expect((yield* runGit(repoDir, ["branch", "--show-current"])).stdout.trim()).toBe("main");
        }
        const result = yield* Fiber.join(preparing);

        const head = expectedHead === "local" ? localHead : pullHead;
        expect((yield* runGit(repoDir, ["rev-parse", "feature/pr-existing"])).stdout.trim()).toBe(
          head,
        );
        expect(
          (yield* runGit(result.worktreePath as string, ["rev-parse", "HEAD"])).stdout.trim(),
        ).toBe(head);
        expect(result).toMatchObject({ branch: "feature/pr-existing", isOnPullRequestHead });
      }),
  );

  it.effect.each(["adds", "removes"] as const)(
    "checks out the submodules of the head an existing PR branch moves onto (head %s one)",
    (headChange) =>
      Effect.gen(function* () {
        const submoduleDir = yield* makeTempDir("goat-git-submodule-");
        yield* initRepo(submoduleDir);
        const repoDir = yield* makeTempDir("goat-git-manager-");
        yield* initRepo(repoDir);
        const remoteDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
        yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
        yield* runGit(repoDir, ["checkout", "-b", "feature/pr-existing"]);
        if (headChange === "removes") {
          yield* runGit(repoDir, [
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            submoduleDir,
            "shared",
          ]);
          yield* runGit(repoDir, ["commit", "-m", "Add shared submodule"]);
        }
        yield* runGit(repoDir, ["push", "-u", "origin", "feature/pr-existing"]);
        yield* runGit(repoDir, ["checkout", "-b", "author-push"]);
        if (headChange === "adds") {
          yield* runGit(repoDir, [
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            submoduleDir,
            "shared",
          ]);
          yield* runGit(repoDir, ["commit", "-m", "Add shared submodule"]);
        } else {
          yield* runGit(repoDir, ["rm", "shared"]);
          yield* runGit(repoDir, ["commit", "-m", "Remove shared submodule"]);
        }
        yield* runGit(repoDir, ["push", "origin", "author-push:feature/pr-existing"]);
        const pullHead = (yield* runGit(repoDir, ["rev-parse", "author-push"])).stdout.trim();
        yield* runGit(repoDir, ["checkout", "main"]);

        const { manager } = yield* makeManager({
          providerScenario: {
            pullRequest: {
              number: 89,
              title: "Submodule PR",
              headSha: pullHead,
              url: "https://github.com/pingdotgg/codething-mvp/pull/89",
              baseRefName: "main",
              headRefName: "feature/pr-existing",
              state: "open",
              isCrossRepository: false,
              headRepositoryNameWithOwner: "pingdotgg/codething-mvp",
              headRepositoryOwnerLogin: "pingdotgg",
            },
            repositoryCloneUrls: {
              "pingdotgg/codething-mvp": { url: remoteDir, sshUrl: remoteDir },
            },
          },
        });

        const result = yield* preparePullRequestThread(manager, {
          cwd: repoDir,
          reference: "89",
          mode: "worktree",
        });

        const worktreePath = result.worktreePath as string;
        expect((yield* runGit(worktreePath, ["rev-parse", "HEAD"])).stdout.trim()).toBe(pullHead);
        expect(NodeFS.existsSync(NodePath.join(worktreePath, "shared", "README.md"))).toBe(
          headChange === "adds",
        );
        expect((yield* runGit(worktreePath, ["status", "--porcelain"])).stdout).toBe("");
        expect(result).toMatchObject({ isOnPullRequestHead: true });
      }).pipe(
        // Git refuses `file:` submodule transports (CVE-2022-39253) despite repo config; GOAT's
        // git runs inherit the process environment, so the fixture allows it there for this case.
        (effect) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              const previous = process.env.GIT_ALLOW_PROTOCOL;
              process.env.GIT_ALLOW_PROTOCOL = "file";
              return previous;
            }),
            (previous) =>
              Effect.sync(() => {
                if (previous === undefined) delete process.env.GIT_ALLOW_PROTOCOL;
                else process.env.GIT_ALLOW_PROTOCOL = previous;
              }),
          ).pipe(Effect.andThen(effect), Effect.scoped),
      ),
  );
});
