import { checkUsage } from "./MemoryUsageScan.testkit.ts";
import { assert, describe, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as AutomationHold from "../automationHold.ts";
import * as Hub from "./MemoryHubService.ts";
import * as Compactor from "./MemoryCompactor.ts";
import {
  id,
  space,
  memoryId,
  hubEnv,
  otherEnv,
  principal,
  live,
  seed,
  operation,
  pushInput,
  conflict,
} from "./MemoryHubService.testkit.ts";

describe("MemoryHubService", () => {
  it.effect("automation hold refuses hub join, push and claim; release permits them", () =>
    Effect.gen(function* () {
      const hold = yield* AutomationHold.makeInMemory({
        reason: "channel-copy",
        heldAt: "2026-10-25T00:00:00.000Z",
      });
      yield* Effect.gen(function* () {
        yield* seed;
        const hub = yield* Hub.MemoryHubService;
        const join = {
          protocolVersion: 1 as const,
          memorySpaceId: space,
          environmentId: otherEnv,
        };
        const claim: M.MemoryHubClaimInput = {
          protocolVersion: 1,
          memorySpaceId: space,
          memoryId,
          holderEnvironmentId: hubEnv,
          conflictId: M.MemoryConflictId.make(id(60)),
          conflictHeadSet: [M.MemoryRevisionId.make(id(110)), M.MemoryRevisionId.make(id(111))],
          attemptId: M.MemoryOperationId.make(id(50)),
          frozenDefaultModelSelection: {
            instanceId: M.ProviderInstanceId.make("synthetic-provider"),
            model: "synthetic-model",
          },
        };
        for (const request of [
          hub.join(join, principal(otherEnv)).pipe(Effect.asVoid),
          hub.push(pushInput(operation()), principal()).pipe(Effect.asVoid),
          hub.claim(claim, principal()).pipe(Effect.asVoid),
        ]) {
          const error = yield* request.pipe(Effect.flip);
          assert.strictEqual(error._tag, "MemoryHubError");
          if (error._tag === "MemoryHubError") assert.strictEqual(error.code, "hub_disabled");
        }
        const sql = yield* SqlClient.SqlClient;
        assert.strictEqual(
          (yield* sql<{ count: number }>`SELECT count(*) AS count FROM memory_hub_operations`)[0]!
            .count,
          0,
        );
        yield* hold.release;
        const pushed = yield* hub.push(pushInput(operation()), principal());
        assert.strictEqual(pushed.receipts[0]!.outcome, "accepted");
        const conflicting = yield* conflict;
        const lease = yield* hub.claim(conflicting.claim, principal());
        assert.strictEqual(lease.holderEnvironmentId, hubEnv);
        yield* (yield* Compactor.MemoryCompactor).compact(principal());
        assert.strictEqual((yield* hub.join(join, principal(otherEnv))).hubEnvironmentId, hubEnv);
      }).pipe(
        checkUsage,
        Effect.provide(live),
        Effect.provideService(AutomationHold.AutomationHold, hold),
      );
    }),
  );
});
