import { assert, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ProjectId } from "@goat/contracts";
import { refuseSshHostsScoped } from "@goat/ssh/hostAccess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Startup from "./serverRuntimeStartup.ts";
import * as Git from "./vcs/GitVcsDriver.ts";

it.effect("regression: a server refused SSH never pulls a behind checkout at startup", () =>
  Effect.gen(function* () {
    let pulls = 0;
    yield* refuseSshHostsScoped();
    yield* Startup.autoPullProjects([{ id: ProjectId.make("copied"), workspaceRoot: "/copied" }], {
      ...DEFAULT_SERVER_SETTINGS,
      defaultAutoPull: true,
    }).pipe(
      Effect.provide(
        Layer.mock(Git.GitVcsDriver)({
          statusDetails: () =>
            Effect.succeed({
              isRepo: true,
              hasOriginRemote: true,
              isDefaultBranch: true,
              branch: "dev",
              upstreamRef: "origin/dev",
              hasWorkingTreeChanges: false,
              workingTree: { files: [], insertions: 0, deletions: 0 },
              hasUpstream: true,
              aheadCount: 0,
              behindCount: 1,
              aheadOfDefaultCount: 0,
            }),
          pullCurrentBranch: () =>
            Effect.sync(() => {
              pulls++;
              return { status: "pulled" as const, refName: "dev", upstreamRef: "origin/dev" };
            }),
        }),
      ),
    );
    assert.strictEqual(pulls, 0);
  }).pipe(Effect.scoped),
);
