import { assert, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ProjectId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as AutomationHold from "./automationHold.ts";
import * as Startup from "./serverRuntimeStartup.ts";
import * as Git from "./vcs/GitVcsDriver.ts";

it.effect("held startup pulls do no git work; release pulls the eligible checkout", () =>
  Effect.gen(function* () {
    const hold = yield* AutomationHold.makeInMemory({
      reason: "channel-copy",
      heldAt: "2026-10-25T00:00:00.000Z",
    });
    const parked = yield* Deferred.make<void>();
    const pulled = yield* Deferred.make<void>();
    let statuses = 0;
    let pulls = 0;
    yield* Effect.gen(function* () {
      const fiber = yield* Startup.autoPullProjects(
        [{ id: ProjectId.make("held"), workspaceRoot: "/held" }],
        { ...DEFAULT_SERVER_SETTINGS, defaultAutoPull: true },
      ).pipe(Effect.forkScoped);
      yield* Effect.raceFirst(Deferred.await(parked), Deferred.await(pulled));
      assert.strictEqual(statuses, 0);
      assert.strictEqual(pulls, 0);
      yield* hold.release;
      yield* Fiber.join(fiber);
      assert.strictEqual(statuses, 1);
      assert.strictEqual(pulls, 1);
    }).pipe(
      Effect.provide(
        Layer.mock(Git.GitVcsDriver)({
          statusDetails: () =>
            Effect.sync(() => {
              statuses++;
              return {
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
              };
            }),
          pullCurrentBranch: () =>
            Effect.sync(() => {
              pulls++;
              return { status: "pulled" as const, refName: "dev", upstreamRef: "origin/dev" };
            }).pipe(Effect.tap(() => Deferred.succeed(pulled, undefined))),
        }),
      ),
      Effect.provideService(AutomationHold.AutomationHold, {
        ...hold,
        awaitRelease: Deferred.succeed(parked, undefined).pipe(Effect.andThen(hold.awaitRelease)),
      }),
    );
  }).pipe(Effect.scoped),
);
