// @effect-diagnostics nodeBuiltinImport:off -- real Git fixtures run in temporary repositories.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@goat/contracts";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../../processRunner.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { createManager, openInput } from "../../terminal/Manager.testkit.ts";
import { folderReplacedNotice } from "../../terminal/processEventQueue.ts";
import { layerRealGit } from "../ProviderTurnStartService.testkit.ts";
import { makeRestoreThreadWorkspace } from "./restoreThreadWorkspace.ts";

// goat#3690: a terminal left open in a worktree GOAT recreates keeps its shell in the old folder.
// it.live: the terminal manager and git run on the real clock.
it.live("restoring a removed worktree tells the terminal still open in it", () =>
  Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-restore-notice-"))),
      (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
    );
    const repo = NodePath.join(root, "repo");
    const worktreePath = NodePath.join(root, "worktree");
    NodeFS.mkdirSync(repo);
    const git = (cwd: string, args: string[]) =>
      NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, [
      "-c",
      "user.name=T",
      "-c",
      "user.email=t@example.com",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "base",
    ]);
    git(repo, ["worktree", "add", "-q", "-b", "feature", worktreePath]);
    const { manager, getEvents } = yield* createManager(50);
    yield* manager.open(
      openInput({ threadId: "thread-restore", terminalId: "person", cwd: worktreePath }),
    );
    git(repo, ["worktree", "remove", "--force", worktreePath]);

    const restore = yield* makeRestoreThreadWorkspace.pipe(
      Effect.provideService(TerminalManager.TerminalManager, manager),
    );
    yield* restore({
      threadId: ThreadId.make("thread-restore"),
      cwd: repo,
      worktreePath,
      branch: "feature",
    });

    const notice = folderReplacedNotice(worktreePath);
    const told = (yield* getEvents).filter(
      (event) => event.type === "output" && event.terminalId === "person" && event.data === notice,
    );
    assert.strictEqual(told.length, 1);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(McpProviderSessions.layer, ProcessRunner.layer).pipe(
        Layer.provideMerge(layerRealGit),
      ),
    ),
    Effect.scoped,
  ),
);
