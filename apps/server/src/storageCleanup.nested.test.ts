import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";
import {
  cleanupFixture,
  submoduleCleanupFixture,
  runCleanupTest,
} from "./storageCleanup.testkit.ts";

it.live.each(["repository", "uppercase", "bare"] as const)(
  "keeps a worktree holding an ignored nested %s",
  (kind) =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, repo, worktree, command, setPolicy } = yield* cleanupFixture();
        setPolicy("tracked-changes");
        const nested = `${worktree}/dist/nested`;
        if (kind === "uppercase") {
          yield* command(repo, ["worktree", "add", "-b", "nested", nested]);
        } else {
          yield* command(repo, [
            "clone",
            "--no-hardlinks",
            ...(kind === "bare" ? ["--bare"] : []),
            repo,
            nested,
          ]);
        }
        if (kind === "uppercase") yield* fs.rename(`${nested}/.git`, `${nested}/.GIT`);
        yield* fs.writeFileString(`${nested}/uncommitted.txt`, "irreplaceable work\n");
        expect((yield* command(worktree, ["status", "--porcelain"])).stdout).toBe("");
        const report = yield* service.runNow;
        expect(report.entries.find((entry) => entry.path === worktree)).toMatchObject({
          outcome: "kept",
          reason: "Contains a nested Git repository",
        });
        expect(yield* fs.readFileString(`${nested}/uncommitted.txt`)).toBe("irreplaceable work\n");
        expect(
          (yield* command(nested, [
            ...(kind === "uppercase"
              ? [
                  `--git-dir=${(yield* fs.readFileString(`${nested}/.GIT`)).trim().slice(8)}`,
                  "--work-tree=.",
                ]
              : []),
            "-c",
            "safe.bareRepository=all",
            "rev-parse",
            "--is-bare-repository",
          ])).stdout.trim(),
        ).toBe(String(kind === "bare"));
      }),
    ),
);

it.live("inspects a pnpm store excluded from reclaimed bytes for nested repositories", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const { service, fs, repo, worktree, command, setPolicy } = yield* cleanupFixture();
      setPolicy("tracked-changes");
      const storeDir = yield* fs.makeTempDirectoryScoped({ prefix: "cleanup-store-" });
      const nested = `${worktree}/node_modules/.pnpm/nested`;
      yield* command(repo, ["clone", "--no-hardlinks", repo, nested]);
      yield* fs.writeFileString(`${nested}/uncommitted.txt`, "keep me");
      yield* fs.writeFileString(
        `${worktree}/node_modules/.modules.yaml`,
        JSON.stringify({ storeDir, virtualStoreDir: ".pnpm" }),
      );
      const report = yield* service.runNow;
      expect(report.entries.find((entry) => entry.path === worktree)).toMatchObject({
        outcome: "kept",
        reason: "Contains a nested Git repository",
      });
      expect(yield* fs.readFileString(`${nested}/uncommitted.txt`)).toBe("keep me");
    }),
  ),
);

it.live("keeps an ignored repository inside a registered submodule", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const { service, fs, repo, worktree, submodule, command, setPolicy } =
        yield* submoduleCleanupFixture();
      setPolicy("tracked-changes");
      const nested = `${submodule}/dist/nested`;
      yield* command(repo, ["clone", "--no-hardlinks", repo, nested]);
      yield* fs.writeFileString(`${nested}/uncommitted.txt`, "keep me");
      const report = yield* service.runNow;
      expect(report.entries.find((entry) => entry.path === worktree)).toMatchObject({
        outcome: "kept",
        reason: "Contains a nested Git repository",
      });
      expect(yield* fs.readFileString(`${nested}/uncommitted.txt`)).toBe("keep me");
    }),
  ),
);
