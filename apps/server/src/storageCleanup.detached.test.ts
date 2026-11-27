import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";
import { cleanupFixture, runCleanupTest } from "./storageCleanup.testkit.ts";

describe("detached worktree cleanup", () => {
  it.live("removes a clean detached worktree only when every commit is on a branch", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, worktree, command } = yield* cleanupFixture();
        yield* command(worktree, ["checkout", "--detach"]);
        yield* fs.writeFileString(`${worktree}/tracked.txt`, "unpushed\n");
        yield* command(worktree, ["commit", "-am", "unpushed"]);
        expect((yield* service.runNow).entries[0]).toMatchObject({ outcome: "kept" });
        yield* command(worktree, ["checkout", "--detach", "main"]);
        yield* command(worktree, ["-c", "sequence.editor=echo break >>", "rebase", "-i", "--root"]);
        expect((yield* service.runNow).entries[0]).toMatchObject({ outcome: "kept" });
        yield* command(worktree, ["rebase", "--abort"]);
        yield* command(worktree, ["checkout", "-b", "topic", "main"]);
        yield* command(worktree, ["commit", "--allow-empty", "-m", "topic"]);
        yield* command(worktree, ["checkout", "--detach", "main"]);
        yield* fs.writeFileString(`${worktree}/tracked.txt`, "autostashed\n");
        yield* command(worktree, ["merge", "--autostash", "--no-ff", "--no-commit", "topic"]);
        expect((yield* service.runNow).entries[0]).toMatchObject({ outcome: "kept" });
        yield* command(worktree, ["merge", "--abort"]);
        expect(yield* fs.readFileString(`${worktree}/tracked.txt`)).toBe("autostashed\n");
        yield* command(worktree, ["checkout", "--", "tracked.txt"]);
        yield* command(worktree, ["bisect", "start"]);
        expect((yield* service.runNow).entries[0]).toMatchObject({ outcome: "kept" });
        yield* command(worktree, ["bisect", "reset"]);
        expect((yield* service.runNow).entries[0]).toMatchObject({ outcome: "removed" });
      }),
    ),
  );
});
