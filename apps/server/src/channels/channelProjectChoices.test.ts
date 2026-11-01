import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { makeChannelProjectChoices } from "./channelProjectChoices.ts";

const layer = Layer.mergeAll(
  ServerConfig.layerTest(process.cwd(), { prefix: "goat-project-choices-" }),
  ServerSettings.layerTest(),
  Layer.mock(ThreadManagement.ThreadManagementService)({
    listProjectThreads: () => Effect.succeed([]),
  }),
).pipe(Layer.provideMerge(NodeServices.layer));

it.effect(
  "offers projects a person means and leaves out folders of projects and GOAT worktrees",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-project-choices-tree-" });
      const dir = (...parts: Array<string>) =>
        fs
          .makeDirectory(path.join(root, ...parts), { recursive: true })
          .pipe(Effect.as(path.join(root, ...parts)));
      // The issue's list: a home folder, an org folder, repositories, and a GOAT worktree.
      const home = yield* dir("jun");
      const org = yield* dir("jun", "developer", "goat-si");
      const goat = yield* dir("jun", "developer", "goat-si", "goat");
      yield* dir("jun", "developer", "goat-si", "goat", ".git");
      const nested = yield* dir("jun", "developer", "goat-si", "goat", "apps", "site");
      const opencodex = yield* dir("jun", "developer", "opencodex");
      const worktree = path.join(config.worktreesDir, "goat", "fix-bundle-c-ssh-runtime");
      yield* fs.makeDirectory(worktree, { recursive: true });
      const project = (id: string, workspaceRoot: string) => ({ id, title: id, workspaceRoot });
      const choices = yield* makeChannelProjectChoices;
      const asked = yield* choices.question(
        [
          project("jun", home),
          project("goat-si", org),
          project("goat-si/goat", goat),
          project("site", nested),
          project("opencodex", opencodex),
          project("fix-bundle-c-ssh-runtime", worktree),
        ],
        true,
      );
      // A repository holding a nested project stays; plain folders holding projects do not.
      assert.deepStrictEqual(asked.choices, [
        "goat-si/goat",
        "site",
        "opencodex",
        "This machine (no project)",
      ]);
      assert.notInclude(asked.text, "fix-bundle-c-ssh-runtime");
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("falls back to every project when none would be left", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const worktree = path.join(config.worktreesDir, "goat", "only-worktree");
    yield* fs.makeDirectory(worktree, { recursive: true });
    const choices = yield* makeChannelProjectChoices;
    const asked = yield* choices.question(
      [{ id: "only-worktree", title: "only-worktree", workspaceRoot: worktree }],
      false,
    );
    assert.deepStrictEqual(asked.choices, ["only-worktree"]);
  }).pipe(Effect.provide(layer)),
);
