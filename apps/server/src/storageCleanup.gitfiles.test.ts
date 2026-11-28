import * as Effect from "effect/Effect";
import { expect, it } from "@effect/vitest";
import { cleanupFixture, runCleanupTest } from "./storageCleanup.testkit.ts";

it.live("removes a worktree whose ignored folder holds a dangling gitfile", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const { service, fs, worktree } = yield* cleanupFixture();
      yield* fs.makeDirectory(`${worktree}/dist/suite`, { recursive: true });
      yield* fs.writeFileString(`${worktree}/dist/suite/.git`, "gitdir: ../.git/modules/x\n");
      const [entry] = (yield* service.runNow).entries;
      expect(entry).toMatchObject({ outcome: "removed" });
      expect(yield* fs.exists(worktree)).toBe(false);
    }),
  ),
);

it.live("keeps a worktree whose gitfile target exists only with its trailing space", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const { service, fs, worktree } = yield* cleanupFixture();
      yield* fs.makeDirectory(`${worktree}/dist/suite/git `, { recursive: true });
      yield* fs.writeFileString(`${worktree}/dist/suite/.git`, "gitdir: git \n");
      const [entry] = (yield* service.runNow).entries;
      expect(entry).toMatchObject({ outcome: "kept", reason: "Contains a nested Git repository" });
    }),
  ),
);
