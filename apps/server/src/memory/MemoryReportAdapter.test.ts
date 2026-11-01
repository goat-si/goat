import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as Adapter from "./MemoryReportAdapter.ts";
import * as Service from "./MemoryService.ts";
import { botMessages, environmentId, setupBot } from "../channels/testkit/ChannelHarness.ts";
import {
  insertReport,
  makeReportHarness,
  memory,
  resolution,
  space,
} from "./testkit/MemoryReportHarness.ts";

describe("MemoryReportAdapter", () => {
  it.effect.each(["resolved", "reverted", "failed"])(
    "records safe %s metadata idempotently without a provider",
    (outcome) => {
      const harness = makeReportHarness();
      return Effect.gen(function* () {
        yield* TestClock.setTime(0);
        yield* setupBot;
        yield* insertReport(1, outcome);
        const service = yield* Service.MemoryService;
        const adapter = yield* Adapter.MemoryReportAdapter;
        const report = (yield* service.acquireReports({
          owner: environmentId,
          now: 0,
          until: 60_000,
          limit: 1,
        }))[0]!;
        const first = yield* adapter.deliver(report);
        const second = yield* adapter.deliver(report);
        assert.strictEqual(second.sequence, first.sequence);
        const records = yield* botMessages;
        assert.strictEqual(records.messages.length, 1);
        assert.deepStrictEqual(records.messages[0]!.channel?.memory, {
          memorySpaceId: space,
          environmentId,
          memoryId: memory,
          resolutionId: resolution,
        });
        assert.strictEqual(
          records.messages[0]!.text,
          {
            resolved: "A memory conflict was resolved.",
            reverted: "A memory resolution was reverted.",
            failed: "A memory conflict could not be resolved.",
          }[outcome],
        );
        assert.isEmpty(records.runs);
        assert.isEmpty(harness.providerCalls);
        assert.isEmpty(harness.world.sends);
        assert.isEmpty(harness.slackSent);
      }).pipe(Effect.provide(harness.layer));
    },
  );
  it.effect("missing or contradictory durable target cannot write a timeline", () => {
    const harness = makeReportHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* insertReport();
      const service = yield* Service.MemoryService;
      const adapter = yield* Adapter.MemoryReportAdapter;
      const sql = yield* SqlClient.SqlClient;
      const report = (yield* service.acquireReports({
        owner: environmentId,
        now: 0,
        until: 60_000,
        limit: 1,
      }))[0]!;
      yield* sql`UPDATE memory_report_outbox SET resolving_environment_id='foreign'`;
      assert.strictEqual((yield* Effect.flip(adapter.deliver(report))).code, "unavailable");
      yield* sql`DELETE FROM memory_report_outbox`;
      assert.strictEqual((yield* Effect.flip(adapter.deliver(report))).code, "unavailable");
      assert.isEmpty((yield* botMessages).messages);
      assert.isEmpty(harness.providerCalls);
    }).pipe(Effect.provide(harness.layer));
  });
});
