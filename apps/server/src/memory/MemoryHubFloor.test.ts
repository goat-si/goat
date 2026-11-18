import { assert, describe, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Hub from "./MemoryHubService.ts";
import { checkUsage } from "./MemoryUsageScan.testkit.ts";
import {
  hubEnv,
  id,
  live,
  operation,
  otherEnv,
  principal,
  pullInput,
  pushInput,
  seed,
  space,
} from "./MemoryHubService.testkit.ts";

describe("memory hub floor", () => {
  it.effect("names members that block a wide write on the V1 floor", () =>
    Effect.gen(function* () {
      yield* seed;
      const hub = yield* Hub.MemoryHubService;
      const wide = operation();
      const result = yield* hub.push(
        pushInput({
          ...wide,
          payload: {
            ...wide.payload,
            derivedFromMemoryRevisions: Array.from({ length: 101 }, (_, n) =>
              M.MemoryRevisionId.make(id(200 + n)),
            ),
          },
        }),
        principal(),
      );
      assert.include(result.receipts[0], {
        outcome: "rejected",
        failureCode: "hub_upgrade_required",
      });
      assert.deepStrictEqual(Reflect.get(result.receipts[0]!, "upgradeRequiredMembers"), [
        hubEnv,
        otherEnv,
      ]);
      const page = yield* hub.pull(pullInput, principal());
      assert.deepStrictEqual(page.entries, []);
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("fences old and partial advertisements after floor activation", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO memory_space_features VALUES (${space},1000,0)`;
      const hub = yield* Hub.MemoryHubService;
      const old = yield* hub.pull(pullInput, principal()).pipe(Effect.result);
      const partial = yield* hub
        .push(Object.assign(pushInput(operation()), { features: ["derivedCap1000"] }), principal())
        .pipe(Effect.result);
      assert.include(old, { _tag: "Failure" });
      assert.include(partial, { _tag: "Failure" });
      if (old._tag === "Failure") assert.include(old.failure, { code: "unsupported_protocol" });
      if (partial._tag === "Failure")
        assert.include(partial.failure, { code: "unsupported_protocol" });
    }).pipe(checkUsage, Effect.provide(live)),
  );
});
