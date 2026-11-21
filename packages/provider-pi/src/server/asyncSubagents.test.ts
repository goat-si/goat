import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { makeAsyncSubagents } from "./asyncSubagents.ts";
import type { ActivePiTurn } from "./turnState.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.effect("interrupts tracked async members and clears background work on Stop", () =>
  Effect.gen(function* () {
    const turn = { providerTurn: { id: "turn-1" } } as ActivePiTurn;
    const events: string[] = [];
    const tracker = makeAsyncSubagents({
      member: (_turn, _tool, member) =>
        Effect.sync(() => {
          events.push(`${member.id}:${member.status}`);
        }),
      pending: (_turn, pending) =>
        Effect.sync(() => {
          events.push(`pending:${pending}`);
        }),
    });
    yield* tracker.track("run-1", turn, "tool-1");
    const line = `PI_SUBAGENT_ASYNC_JSON:${encode({ runs: [{ id: "run-1", state: "running", children: [{ id: "member-1", kind: "step", agent: "scout", state: "running" }] }] })}`;
    yield* tracker.snapshot([line]);
    yield* tracker.snapshot([line]);
    yield* tracker.clear(turn);
    yield* tracker.snapshot([line]);
    assert.deepEqual(events, [
      "pending:true",
      "member-1:running",
      "member-1:interrupted",
      "pending:false",
    ]);
  }),
);
