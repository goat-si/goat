import * as NodePath from "node:path";

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";

import { makeTempDir, removePath, makeDirectory } from "./testkit/fileFixtures.ts";
import { layerGitManagerTest, makeManager } from "./GitManagerTestHarness.ts";

it.layer(layerGitManagerTest)("GitManager", (it) => {
  it.effect("status returns an explicit non-repo result for deleted directories", () =>
    Effect.gen(function* () {
      const rootDir = yield* makeTempDir("goat-git-manager-missing-dir-");
      const cwd = NodePath.join(rootDir, "deleted-repo");
      yield* makeDirectory(cwd);
      yield* removePath(cwd);
      const { manager } = yield* makeManager();

      const status = yield* manager.status({ cwd });

      expect(status).toEqual({
        isRepo: false,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: null,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        aheadOfDefaultCount: 0,
        pr: null,
      });
    }),
  );
});
