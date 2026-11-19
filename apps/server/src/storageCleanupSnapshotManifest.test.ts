// @effect-diagnostics nodeBuiltinImport:off - writes the concurrent edit at the verification boundary.
import * as NodeFS from "node:fs";
import { expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Tracer from "effect/Tracer";
import { cleanupFixture, LEGACY_WORKTREE_RULES, runCleanupTest } from "./storageCleanup.testkit.ts";

it.live(
  "keeps an uninitialized submodule worktree and a tracked edit arriving after snapshot verification",
  () =>
    runCleanupTest(
      Effect.gen(function* () {
        let verificationCount = 0;
        let editedAfterVerification = false;
        let worktreePath = "";
        const tracer = Tracer.make({
          span: (options) => {
            const span = new Tracer.NativeSpan(options);
            if (options.name !== "WorktreeSnapshot.verifySnapshot") return span;
            const end = span.end.bind(span);
            span.end = (...args) => {
              end(...args);
              verificationCount++;
              if (verificationCount === 2) {
                NodeFS.writeFileSync(`${worktreePath}/tracked.txt`, "late edit\n");
                editedAfterVerification = true;
              }
            };
            return span;
          },
        });
        const fixture = yield* cleanupFixture({
          ...DEFAULT_SERVER_SETTINGS.storageCleanup,
          ...LEGACY_WORKTREE_RULES,
          worktreeAfterDays: 8,
          worktreeSnapshotChanges: true,
        }).pipe(Effect.withTracer(tracer));
        const { fs, worktree, repo, command } = fixture;
        worktreePath = worktree;
        const head = (yield* command(worktree, ["rev-parse", "HEAD"])).stdout.trim();
        yield* fs.writeFileString(
          `${worktree}/.gitmodules`,
          '[submodule "module"]\n\tpath = module\n\turl = /unused\n',
        );
        yield* command(worktree, ["add", ".gitmodules"]);
        yield* command(worktree, ["update-index", "--add", "--cacheinfo", `160000,${head},module`]);
        yield* command(worktree, ["commit", "-m", "record uninitialized module"]);
        yield* command(repo, ["merge", "--ff-only", "feature"]);
        yield* fs.makeDirectory(`${worktree}/module`);
        yield* fs.writeFileString(`${worktree}/tracked.txt`, "initial edit\n");
        const report = yield* fixture.service.runNow;
        expect(editedAfterVerification).toBe(true);
        expect(report.entries.find((entry) => entry.path === worktree)).toMatchObject({
          outcome: "kept",
          reason: expect.stringContaining("uninitialized submodule"),
        });
        expect(yield* fs.exists(worktree)).toBe(true);
        expect(yield* fs.readFileString(`${worktree}/tracked.txt`)).toBe("late edit\n");
      }),
    ),
);
