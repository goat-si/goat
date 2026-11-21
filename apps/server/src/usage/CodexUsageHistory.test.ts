import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as CodexUsageHistory from "./CodexUsageHistory.ts";
import { seedCodexHistory } from "./codexUsageHistory.testkit.ts";

describe("Codex usage history", () => {
  const historyLayer = CodexUsageHistory.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));
  const request = (nativeTurnId: string) => ({
    sessionId: "session",
    nativeTurnId,
    model: "gpt-6-astra",
  });

  it.effect("resolves a batch from each attempt's first running selection", () =>
    Effect.gen(function* () {
      yield* seedCodexHistory({ id: "fast" });
      yield* seedCodexHistory({
        id: "ultrafast",
        options: [{ id: "serviceTier", value: "ultrafast" }],
      });
      yield* seedCodexHistory({ id: "legacy-option", options: [{ id: "fastMode", value: true }] });
      yield* seedCodexHistory({ id: "standard", options: [] });
      const requests = ["fast", "ultrafast", "legacy-option", "standard", "fast"].map(request);
      const history = yield* CodexUsageHistory.CodexUsageHistory;
      const resolved = yield* history.resolve(requests);
      assert.strictEqual(resolved.size, requests.length);
      assert.deepStrictEqual(
        requests.map((item) => resolved.get(item)),
        ["fast", "ultrafast", "fast", "standard", "fast"],
      );
    }).pipe(Effect.provide(historyLayer)),
  );

  it.effect("leaves ambiguous, mismatched, and missing V2 evidence unresolved", () =>
    Effect.gen(function* () {
      for (const id of [
        "valid",
        "duplicate-model",
        "duplicate-session",
        "imported",
        "v1-event",
        "queued",
        "missing-selection",
      ]) {
        yield* seedCodexHistory({ id });
      }
      yield* seedCodexHistory({
        id: "second-model",
        nativeTurnId: "duplicate-model",
        model: "other-model",
      });
      yield* seedCodexHistory({
        id: "second-session",
        nativeTurnId: "duplicate-session",
        sessionId: "other-session",
      });
      yield* seedCodexHistory({ id: "wrong-model", model: "other-model" });
      yield* seedCodexHistory({ id: "wrong-session", sessionId: "other-session" });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE orchestration_v2_projection_provider_turns
        SET run_attempt_id = NULL WHERE provider_turn_id = 'turn-imported'`;
      yield* sql`DELETE FROM orchestration_v2_projection_run_attempts WHERE attempt_id = 'attempt-imported'`;
      yield* sql`UPDATE orchestration_events SET application_event_version = 1
        WHERE stream_id = 'thread-v1-event'`;
      yield* sql`UPDATE orchestration_events
        SET payload_json = json_set(payload_json, '$.status', 'queued')
        WHERE stream_id = 'thread-queued'`;
      yield* sql`UPDATE orchestration_events
        SET payload_json = json_remove(payload_json, '$.modelSelection')
        WHERE event_id = 'event-missing-selection-2'`;
      const requests = [
        "valid",
        "duplicate-model",
        "duplicate-session",
        "wrong-model",
        "wrong-session",
        "missing-turn",
        "imported",
        "v1-event",
        "queued",
        "missing-selection",
      ].map(request);
      const history = yield* CodexUsageHistory.CodexUsageHistory;
      const resolved = yield* history.resolve(requests);
      assert.deepStrictEqual([...resolved], [[requests[0], "fast"]]);
    }).pipe(Effect.provide(historyLayer)),
  );

  it.effect(
    "reports SQL failures through the typed channel and can resolve again after repair",
    () =>
      Effect.gen(function* () {
        yield* seedCodexHistory({ id: "retry" });
        const history = yield* CodexUsageHistory.CodexUsageHistory;
        const sql = yield* SqlClient.SqlClient;
        const input = request("retry");
        yield* sql`ALTER TABLE orchestration_events RENAME TO unavailable_events`;
        const error = yield* Effect.flip(history.resolve([input]));
        assert.instanceOf(error, CodexUsageHistory.CodexUsageHistoryReadError);
        assert.strictEqual(error.requestedTurnCount, 1);
        yield* sql`ALTER TABLE unavailable_events RENAME TO orchestration_events`;
        assert.strictEqual((yield* history.resolve([input])).get(input), "fast");
      }).pipe(Effect.provide(historyLayer)),
  );
});
