import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { launchAgainst } from "./SshRemoteDispatch.lineage.testkit.ts";
import type { SshRemoteDispatchError } from "./dispatchFailure.ts";

const placement = { ownerKey: "goal:g1:a1", attempt: 0, issuedAt: "2026-11-01T00:00:00.000Z" };
const declares = {
  declaresLaunchedBy: false,
  outside: true,
  declaresReport: true,
  declaresStandingInstructions: true,
} as const;

const refusedWith = (remote: Parameters<typeof launchAgainst>[0]) =>
  launchAgainst(remote).pipe(
    Effect.flip,
    Effect.map((error) => error as SshRemoteDispatchError),
  );

it.effect(
  "a placed launch sends its key to a remote whose fresh listing declares placement and needs the remote's started answer",
  () =>
    Effect.gen(function* () {
      const { result, launches } = yield* launchAgainst({
        ...declares,
        declaresPlacement: true,
        placement,
        launchAnswer: { placement: { outcome: "started" } },
      });
      assert.strictEqual(result.threadId, "new-thread");
      assert.deepStrictEqual(launches.at(-1)?.placement, placement);
      const ignored = yield* refusedWith({ ...declares, declaresPlacement: true, placement });
      assert.isTrue(ignored.launchMayHaveStarted);
    }),
);

it.effect("a remote that does not declare placement is refused before anything is sent", () =>
  Effect.gen(function* () {
    const error = yield* refusedWith({ ...declares, placement });
    assert.strictEqual(error.remoteClassification, "placement_unsupported");
    assert.isFalse(error.launchMayHaveStarted);
  }),
);

it.effect(
  "a failed fresh listing refuses the placement even when an earlier listing on this session was cached",
  () =>
    Effect.gen(function* () {
      const error = yield* refusedWith({
        ...declares,
        declaresPlacement: true,
        placementOnSecondLaunch: placement,
        afterFirstLaunch: {
          advertisesMemory: false,
          declaresMemoryCeiling: false,
          listFailure: "failed",
        },
      });
      assert.strictEqual(error.remoteClassification, "placement_unsupported");
      assert.isFalse(error.launchMayHaveStarted);
    }),
);

it.effect(
  "placement refusals keep their classification, idle thread and uncertainty through the transport",
  () =>
    Effect.gen(function* () {
      const notStarted = yield* refusedWith({
        ...declares,
        declaresPlacement: true,
        placement,
        launchRefusal: {
          _tag: "OrchestratorMcpFailure",
          code: "conflict",
          message: "This placement did not start here: lease lapsed.",
          classification: "placement_not_started",
          mayHaveStarted: false,
          threadId: "placement:abc",
        },
      });
      assert.strictEqual(notStarted.remoteClassification, "placement_not_started");
      assert.strictEqual(notStarted.remoteThreadId, "placement:abc");
      assert.isFalse(notStarted.launchMayHaveStarted);
      // A payload that does not say whether the work started counts as possibly started.
      const pending = yield* refusedWith({
        ...declares,
        declaresPlacement: true,
        placement,
        launchRefusal: {
          code: "conflict",
          message: "still pending",
          classification: "placement_pending",
        },
      });
      assert.strictEqual(pending.remoteClassification, "placement_pending");
      assert.isTrue(pending.launchMayHaveStarted);
    }),
);
