import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { ThreadId } from "@goat/contracts";
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

const findExistingPrWorktree = Effect.fn("findExistingPrWorktree")(function* (repoDir: string) {
  const entries = (yield* runGit(repoDir, ["worktree", "list", "--porcelain"])).stdout;
  const worktree = entries
    .split("\n\n")
    .find((entry) => entry.includes("branch refs/heads/feature/pr-existing"))
    ?.split("\n")[0]
    ?.slice("worktree ".length);
  if (worktree === undefined) throw new Error("Expected the existing PR branch worktree");
  return worktree;
});

it.layer(layerGitManagerTest)("GitManager existing PR branches", (it) => {
  it.effect("refuses a PR worktree path that now contains another repository", () =>
    Effect.gen(function* () {
      const repo = yield* makeTempDir("goat-pr-registered-");
      yield* initRepo(repo);
      const remote = yield* createBareRemote();
      yield* runGit(repo, ["remote", "add", "origin", remote]);
      yield* runGit(repo, ["branch", "feature/pr-replaced"]);
      const worktree = NodePath.join(repo, "linked");
      yield* runGit(repo, ["worktree", "add", worktree, "feature/pr-replaced"]);
      NodeFS.renameSync(worktree, worktree + "-original");
      yield* runGit(repo, ["clone", "--shared", "-b", "feature/pr-replaced", repo, worktree]);
      const { manager } = yield* makeManager({
        providerScenario: {
          pullRequest: {
            number: 84,
            title: "Replaced PR",
            url: "https://github.com/pingdotgg/codething-mvp/pull/84",
            baseRefName: "main",
            headRefName: "feature/pr-replaced",
            state: "open",
          },
        },
      });
      const result = yield* preparePullRequestThread(manager, {
        cwd: repo,
        reference: "84",
        mode: "worktree",
      }).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure.message).toContain("worktree registration");
    }),
  );

  it.effect.each(["checkout hook", "setup script"] as const)(
    "does not report a fresh PR at its target after the %s advances HEAD",
    (stage) =>
      Effect.gen(function* () {
        const repo = yield* makeTempDir("goat-pr-hook-head-");
        yield* initRepo(repo);
        const remote = yield* createBareRemote();
        yield* runGit(repo, ["remote", "add", "origin", remote]);
        const head = (yield* runGit(repo, ["rev-parse", "HEAD"])).stdout.trim();
        yield* runGit(repo, ["push", "origin", "HEAD:refs/pull/88/head"]);
        if (stage === "checkout hook") {
          NodeFS.mkdirSync(NodePath.join(repo, ".git", "hooks"), { recursive: true });
          NodeFS.writeFileSync(
            NodePath.join(repo, ".git", "hooks", "post-checkout"),
            "#!/bin/sh\ngit -c user.name=Test -c user.email=test@example.invalid commit --allow-empty -qm hook\n",
            { mode: 0o755 },
          );
        }
        const git = yield* GitVcsDriver;
        let setups = 0;
        const { manager } = yield* makeManager({
          setupScriptRunner: {
            runForThread: ({ worktreePath }) =>
              Effect.gen(function* () {
                setups += 1;
                if (stage === "setup script" && worktreePath !== null) {
                  yield* runGit(worktreePath, ["commit", "--allow-empty", "-m", "setup"]).pipe(
                    Effect.orDie,
                  );
                }
                return { status: "no-script" as const };
              }).pipe(Effect.provideService(GitVcsDriver, git)),
          },
          providerScenario: {
            pullRequest: {
              number: 88,
              title: "PR target",
              url: "https://github.com/pingdotgg/codething-mvp/pull/88",
              baseRefName: "main",
              headRefName: "feature/advanced",
              state: "open",
              headSha: head,
            },
          },
        });
        const result = yield* preparePullRequestThread(manager, {
          cwd: repo,
          reference: "88",
          mode: "worktree",
          threadId: ThreadId.make("pr-hook-head"),
        });
        expect(result.isOnPullRequestHead).toBe(false);
        expect(setups).toBe(stage === "checkout hook" ? 0 : 1);
      }),
  );

  it.effect.each([
    { localBranch: "ahead", expectedHead: "local", isOnPullRequestHead: false },
    { localBranch: "behind", expectedHead: "pull request", isOnPullRequestHead: true },
    { localBranch: "rewritten", expectedHead: "local", isOnPullRequestHead: false },
    { localBranch: "rewritten-fetched", expectedHead: "local", isOnPullRequestHead: false },
    { localBranch: "wrong-ref", expectedHead: "pull request", isOnPullRequestHead: true },
    { localBranch: "stale-head", expectedHead: "local", isOnPullRequestHead: false },
    { localBranch: "ignored-collision", expectedHead: "local", isOnPullRequestHead: false },
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
        if (localBranch === "ignored-collision") {
          NodeFS.writeFileSync(NodePath.join(repoDir, ".gitignore"), "local.cfg\n");
          yield* runGit(repoDir, ["add", ".gitignore"]);
        }
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
          if (localBranch === "ignored-collision") {
            NodeFS.writeFileSync(NodePath.join(repoDir, "local.cfg"), "tracked PR content\n");
            yield* runGit(repoDir, ["add", "-f", "local.cfg"]);
          }
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
            localBranch === "ignored-collision"
              ? args[0] === "merge-base" &&
                args[1] === "--is-ancestor" &&
                args[2] === localHead &&
                args[3] === pullHead
              : args[0] === "fetch" &&
                args.some((arg) => arg.startsWith("+refs/heads/feature/pr-existing:")),
          reached: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        const { manager } = yield* makeManager({
          ...(localBranch === "checkout-race" || localBranch === "ignored-collision"
            ? { gitSpawnGate: gate }
            : {}),
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
        if (localBranch === "ignored-collision") {
          yield* Deferred.await(gate.reached);
          const worktree = yield* findExistingPrWorktree(repoDir);
          const ignoredFile = NodePath.join(worktree, "local.cfg");
          NodeFS.writeFileSync(ignoredFile, "ignored user content\n");
          expect((yield* runGit(worktree, ["status", "--porcelain"])).stdout).toBe("");
          yield* Deferred.succeed(gate.release, undefined);
        }
        const result = yield* Fiber.join(preparing);
        const worktree = result.worktreePath;
        if (worktree === null) throw new Error("Expected a PR worktree");
        if (localBranch === "ignored-collision") {
          expect(NodeFS.readFileSync(NodePath.join(worktree, "local.cfg"), "utf8")).toBe(
            "ignored user content\n",
          );
        }

        const head = expectedHead === "local" ? localHead : pullHead;
        expect((yield* runGit(repoDir, ["rev-parse", "feature/pr-existing"])).stdout.trim()).toBe(
          head,
        );
        expect((yield* runGit(worktree, ["rev-parse", "HEAD"])).stdout.trim()).toBe(head);
        expect(result).toMatchObject({ branch: "feature/pr-existing", isOnPullRequestHead });
      }),
  );

  const assertDivergentRefreshPreservesEdit = (reuseWorktree: boolean) =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("goat-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-existing"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "README.md"), "published\n");
      yield* runGit(repoDir, ["commit", "-am", "Published PR head"]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/pr-existing"]);
      const localHead = (yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim();
      yield* runGit(repoDir, ["checkout", "-b", "author-rewrite"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "README.md"), "rewritten\n");
      yield* runGit(repoDir, ["commit", "--amend", "-am", "Rewritten PR head"]);
      const pullHead = (yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim();
      yield* runGit(repoDir, ["push", "--force", "origin", "HEAD:refs/heads/feature/pr-existing"]);
      yield* runGit(repoDir, ["update-ref", "refs/remotes/origin/feature/pr-existing", localHead]);
      yield* runGit(repoDir, ["checkout", "main"]);
      const reusedPath = reuseWorktree ? yield* makeTempDir("goat-git-manager-") : null;
      if (reusedPath !== null) {
        yield* runGit(repoDir, ["worktree", "add", reusedPath, "feature/pr-existing"]);
      }

      const gate = {
        matches: (args: ReadonlyArray<string>) =>
          args.includes("--is-ancestor") && args.includes(localHead) && args.includes(pullHead),
        reached: yield* Deferred.make<void>(),
        release: yield* Deferred.make<void>(),
      };
      const { manager } = yield* makeManager({
        gitSpawnGate: gate,
        providerScenario: {
          pullRequest: {
            number: 88,
            title: "Existing branch PR",
            url: "https://github.com/pingdotgg/codething-mvp/pull/88",
            baseRefName: "main",
            headRefName: "feature/pr-existing",
            state: "open",
            headSha: pullHead,
            isCrossRepository: false,
          },
        },
      });
      const preparing = yield* Effect.forkChild(
        preparePullRequestThread(manager, { cwd: repoDir, reference: "88", mode: "worktree" }),
      );
      yield* Deferred.await(gate.reached);
      const worktree = yield* findExistingPrWorktree(repoDir);
      const edited = NodePath.join(worktree, "README.md");
      NodeFS.writeFileSync(edited, "staged user edit\n");
      yield* runGit(worktree, ["add", "README.md"]);
      yield* Deferred.succeed(gate.release, undefined);
      const result = yield* Fiber.join(preparing);

      expect((yield* runGit(worktree, ["show", ":README.md"])).stdout).toBe("staged user edit\n");
      expect(NodeFS.readFileSync(edited, "utf8")).toBe("staged user edit\n");
      expect((yield* runGit(worktree, ["rev-parse", "HEAD"])).stdout.trim()).toBe(localHead);
      expect(result.isOnPullRequestHead).toBe(false);
      if (reusedPath !== null) {
        expect(result.worktreePath && NodeFS.realpathSync.native(result.worktreePath)).toBe(
          NodeFS.realpathSync.native(reusedPath),
        );
      }
    });

  it.effect("preserves a staged edit racing the refresh of a divergent PR branch", () =>
    assertDivergentRefreshPreservesEdit(false),
  );

  it.effect("preserves a staged edit racing the refresh of a reused divergent PR worktree", () =>
    assertDivergentRefreshPreservesEdit(true),
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
