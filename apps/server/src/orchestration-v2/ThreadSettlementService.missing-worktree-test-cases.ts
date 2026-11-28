import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import { TestClock } from "effect/testing";
import * as AutomationHold from "../automationHold.ts";
import * as ThreadSettlementService from "./ThreadSettlementService.ts";
import { appThread, settledEvent } from "./ThreadSettlementService.admission-test-cases.ts";
import type * as Harness from "./ThreadSettlementService.test.ts";
export function settlementMissingWorktreeTests({
  makeHarness,
  makeSnapshot,
}: Pick<typeof Harness, "makeHarness" | "makeSnapshot">) {
  it.effect("runs an explicit settle script in its worktree while automation is held", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const warnings: string[] = [];
        const logger = Logger.make(({ logLevel, message }) => {
          if (logLevel === "Warn") warnings.push(JSON.stringify(message));
        });
        const shared = appThread("shared-checkout-thread", "settled");
        const missing = appThread("removed-worktree-thread", "settled", "/worktrees/removed");
        const worktree = appThread("worktree-thread", "settled", "/worktrees/thread");
        const hold = yield* AutomationHold.makeInMemory({
          reason: "channel-copy",
          heldAt: "2026-10-25T00:00:00.000Z",
        });
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot(
            [],
            [
              {
                ...(makeSnapshot([]).projects[0] ??
                  (() => {
                    throw new Error("missing project");
                  })()),
                scripts: [
                  {
                    id: "teardown",
                    name: "Teardown",
                    command: "true",
                    icon: "configure",
                    runOnWorktreeCreate: false,
                    runOnSettle: true,
                  },
                ],
              },
            ],
          ),
          currentThreads: [shared, missing, worktree],
          existingWorktreePaths: ["/worktrees/thread"],
        });

        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* service.start();
          yield* Deferred.succeed(fixture.activation, undefined);
          yield* TestClock.adjust(0);
          yield* fixture.publishEvent(settledEvent(shared));
          yield* fixture.publishEvent(settledEvent(missing));
          yield* fixture.publishEvent(settledEvent(worktree));
          const run = yield* Queue.take(fixture.scriptRuns);
          assert.strictEqual(run.threadId, worktree.id);
          assert.strictEqual(run.worktreePath, "/worktrees/thread");
          assert.strictEqual(run.trigger, "settle");
          assert.equal(warnings.length, 1);
          assert.include(warnings[0], missing.id);
          assert.include(warnings[0], "/worktrees/removed");
        }).pipe(
          Effect.provide(
            fixture.layer.pipe(
              Layer.provideMerge(Logger.layer([logger], { mergeWithExisting: false })),
            ),
          ),
          Effect.provideService(AutomationHold.AutomationHold, hold),
        );
      }),
    ),
  );
}
