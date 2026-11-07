import { assert, describe, it } from "@effect/vitest";
import { CommandId } from "@goat/contracts";
import * as Effect from "effect/Effect";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { botMessages, botThreadId, makeHarness, setupBot } from "./testkit/ChannelHarness.ts";

describe("GOAT Bot event lines", () => {
  it.effect("records a bot event line once per record key, without a run", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const record = {
        recordKey: "event:profile-name:main:change-1",
        entry: { type: "event" as const, text: "Renamed to Ada" },
      };
      for (const commandId of ["event-1", "event-1-retry"]) {
        yield* orchestrator.dispatch({
          type: "channel.timeline.record",
          commandId: CommandId.make(commandId),
          threadId: botThreadId,
          record,
        });
      }
      const after = yield* botMessages;
      const events = after.turnItems.flatMap((item) =>
        item.type === "notification" && item.source.kind === "goat_bot_event" ? [item] : [],
      );
      assert.deepStrictEqual(
        events.map((item) => [item.summary, item.ledgerTask]),
        [["Renamed to Ada", undefined]],
      );
      assert.deepStrictEqual(after.runs, []);
    }).pipe(Effect.provide(harness.layer));
  });
});
