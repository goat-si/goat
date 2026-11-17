import { assert, it } from "@effect/vitest";
import { CommandId } from "@goat/contracts";
import { makeProviderFailure } from "@goat/provider-core/server/failure";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as CommandReceiptStore from "../CommandReceiptStore.ts";
import { makeHarness } from "../testkit/ThreadLaunchHarness.ts";
import * as ThreadManagement from "../ThreadManagementService.ts";
import { PreparationClaims } from "./PreparationClaims.ts";
import { orphanRun, runStatus } from "./PreparationOrphans.testkit.ts";
import { STRETCH_CHANGED, dispatchGuardedFail, refusalReason } from "./PreparationStretch.ts";

it.effect(
  "a fail refused for a stretch that moved on commits nothing and leaves its command id usable",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      const claims = yield* PreparationClaims;
      const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const { threadId, runId } = yield* orphanRun("refused-fail");
      const stale = yield* claims.generation(threadId, runId);
      assert.isNotNull(stale);
      // Another fail and a Retry start the next stretch.
      yield* threads.dispatch({
        type: "prepared-run.fail",
        commandId: CommandId.make("command:refused-fail:raw-fail"),
        threadId,
        runId,
        failure: makeProviderFailure({ message: "Git could not reach the remote." }),
      });
      yield* threads.dispatch({
        type: "prepared-run.retry",
        commandId: CommandId.make("command:refused-fail:retry"),
        threadId,
        runId,
      });

      const commandId = CommandId.make("command:refused-fail:guarded");
      const fail = {
        type: "prepared-run.fail" as const,
        commandId,
        threadId,
        runId,
        failure: makeProviderFailure({ message: "Nothing prepared it." }),
      };
      const refused = yield* dispatchGuardedFail(threads, claims, fail, {
        generation: stale!,
        unlessOwned: false,
      }).pipe(Effect.exit);
      assert.equal(
        Exit.isFailure(refused) ? refusalReason(refused.cause) : "committed",
        STRETCH_CHANGED,
      );
      const [written] = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM orchestration_events WHERE command_id = ${commandId}
    `;
      assert.equal(written?.count, 0);
      assert.isTrue(Option.isNone(yield* receipts.getByCommandId(commandId)));
      assert.equal(yield* runStatus(threadId, runId), "preparing");

      // The same command, carrying the current stretch, commits.
      const current = yield* claims.generation(threadId, runId);
      yield* dispatchGuardedFail(threads, claims, fail, {
        generation: current!,
        unlessOwned: false,
      });
      assert.equal(yield* runStatus(threadId, runId), "failed");
    }).pipe(Effect.provide(Layer.provideMerge(CommandReceiptStore.layer, harness.layer)));
  },
);
