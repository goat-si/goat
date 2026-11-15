import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import {
  makeTempDir,
  runRecentThreadOutcomes,
  runScan,
  writeTranscript,
} from "./AgentSessionScanner.testkit.ts";

it.layer(NodeServices.layer)("AgentSessionScanner linked worktrees", (it) => {
  describe("recentThreads", () => {
    it.effect("imports a checkout's sessions from the linked worktrees the scan counts", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
        yield* TestClock.setTime(nowMs);
        const claudeHomePath = yield* makeTempDir("goat-claude-home-");
        const codexHomePath = yield* makeTempDir("goat-codex-home-");
        const repo = yield* makeTempDir("goat-workspace-repo-");
        yield* fileSystem.makeDirectory(path.join(repo, ".git"));
        yield* fileSystem.writeFileString(path.join(repo, ".git", "config"), "[core]\n");
        const worktreeGitDir = path.join(repo, ".git", "worktrees", "feature");
        yield* fileSystem.makeDirectory(worktreeGitDir, { recursive: true });
        yield* fileSystem.writeFileString(path.join(worktreeGitDir, "commondir"), "../..\n");
        yield* fileSystem.writeFileString(
          path.join(worktreeGitDir, "HEAD"),
          "ref: refs/heads/feature\n",
        );
        const worktree = path.join(repo, ".claude", "worktrees", "feature");
        yield* fileSystem.makeDirectory(worktree, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(worktree, ".git"),
          `gitdir: ${worktreeGitDir}\n`,
        );

        for (const [index, [cwd, sessionId]] of [
          [repo, "at-root"],
          [worktree, "in-worktree"],
        ].entries()) {
          yield* writeTranscript({
            filePath: path.join(claudeHomePath, "projects", `-slug-${index}`, `${sessionId}.jsonl`),
            contents: `${JSON.stringify({
              type: "user",
              cwd,
              sessionId,
              message: { role: "user", content: "Fix the project" },
            })}\n${JSON.stringify({
              type: "assistant",
              sessionId,
              message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
            })}\n`,
            mtimeMs: nowMs - (index + 1) * 60 * 60 * 1000,
          });
        }

        const input = { claudeHomePath, codexHomePath };
        const { candidates } = yield* runScan(input);
        expect(candidates.map(({ path, threadCount }) => ({ path, threadCount }))).toEqual([
          { path: repo, threadCount: 2 },
        ]);
        const outcomes = yield* runRecentThreadOutcomes({ ...input, workspaceRoot: repo });
        expect(
          outcomes.flatMap((outcome) =>
            outcome._tag === "Importable"
              ? [{ sessionId: outcome.thread.providerSessionId, worktree: outcome.worktree }]
              : [],
          ),
        ).toEqual([
          { sessionId: "at-root", worktree: null },
          { sessionId: "in-worktree", worktree: { path: worktree, branch: "feature" } },
        ]);
      }),
    );
  });
});
