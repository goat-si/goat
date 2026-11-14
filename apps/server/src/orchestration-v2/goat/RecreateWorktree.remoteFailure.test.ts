// @effect-diagnostics nodeBuiltinImport:off -- real Git fixtures run in temporary repositories.
import { assert, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";
import { layerRealGit } from "../ProviderTurnStartService.testkit.ts";
import { makeRecreateMissingWorktree } from "./RecreateWorktree.ts";

vi.mock("./restoreSnapshot.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./restoreSnapshot.ts")>();
  return {
    ...actual,
    git: (cwd: string, args: string[], options?: Parameters<typeof actual.git>[2]) =>
      args[0] === "remote"
        ? Promise.reject(new Error("remote failed"))
        : actual.git(cwd, args, options),
  };
});

it.effect("recreates from the base when git remote fails", () =>
  Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-recreate-test-"))),
      (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
    );
    const repo = NodePath.join(root, "repo");
    NodeFS.mkdirSync(repo);
    const git = (args: string[]) =>
      NodeChildProcess.execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    git(["init", "-b", "main"]);
    git(["config", "user.name", "Test"]);
    git(["config", "user.email", "test@example.com"]);
    git(["commit", "--allow-empty", "-m", "base"]);
    const recreate = yield* makeRecreateMissingWorktree;
    const result = yield* recreate({
      cwd: repo,
      worktreePath: NodePath.join(root, "worktree"),
      branch: "feature",
    });
    assert.equal(result.restoredFrom, "base");
    assert.equal(result.headSha, git(["rev-parse", "main"]));
  }).pipe(Effect.scoped, Effect.provide(layerRealGit)),
);
