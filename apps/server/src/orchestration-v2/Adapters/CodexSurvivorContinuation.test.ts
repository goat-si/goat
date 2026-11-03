import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ProviderInstanceId, ThreadId } from "@goat/contracts";
import { CodexDetachedAppServerError } from "../../provider/CodexDetachedAppServer.ts";
import { interruptSurvivor, readSurvivorResult } from "./CodexSurvivorContinuation.ts";

it.effect("deduplicates native items repeated across history pages", () =>
  Effect.gen(function* () {
    const result = yield* readSurvivorResult({
      threadId: "thread",
      turnId: "turn",
      readTurns: () => Effect.succeed({ data: [{ id: "turn", status: "completed" }] }),
      readItems: ({ cursor }) =>
        Effect.succeed({
          data: cursor
            ? [
                { turnId: "turn", item: { id: "one" } },
                { turnId: "turn", item: { id: "two" } },
              ]
            : [{ turnId: "turn", item: { id: "one" } }],
          nextCursor: cursor ? null : "next",
        }),
    });
    assert.deepEqual(
      result.items.map((entry) => entry.item.id),
      ["one", "two"],
    );
  }),
);

it.effect("reads all items for the terminal turn and retries one inconsistent snapshot", () =>
  Effect.gen(function* () {
    let reads = 0;
    const result = yield* readSurvivorResult({
      threadId: "thread",
      turnId: "turn",
      readTurns: () =>
        Effect.succeed({ data: [{ id: "turn", status: "completed" }], nextCursor: null }),
      readItems: ({ cursor }) => {
        if (!cursor) reads += 1;
        return Effect.succeed({
          data: [
            {
              turnId: "turn",
              item: { id: cursor ? "two" : "one", text: reads === 1 ? "old" : "new" },
            },
          ],
          nextCursor: cursor ? null : "next",
        });
      },
    });
    assert.equal(reads, 4);
    assert.deepEqual(
      result.items.map((entry) => entry.item.id),
      ["one", "two"],
    );
    assert.equal(result.items[0]?.item.text, "new");
  }),
);

it.effect("fails visibly when terminal history continues to change", () =>
  Effect.gen(function* () {
    let reads = 0;
    const error = yield* readSurvivorResult({
      threadId: "thread",
      turnId: "turn",
      readTurns: () =>
        Effect.succeed({ data: [{ id: "turn", status: "completed" }], nextCursor: null }),
      readItems: () =>
        Effect.sync(() => ({
          data: [{ turnId: "turn", item: { id: "one", text: String(++reads) } }],
          nextCursor: null,
        })),
    }).pipe(Effect.flip);
    assert.equal(
      error.message,
      "Could not read the result of the turn that ran across the restart",
    );
  }),
);

it.effect("a survivor interrupt is sent only after its stop obligation is durable", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    const binding = {
      instanceId: ProviderInstanceId.make("codex"),
      recordName: "record",
      threadId: ThreadId.make("thread"),
      nativeThreadId: "native",
      nativeTurnId: "turn",
    };
    yield* interruptSurvivor({
      binding,
      recordStop: () =>
        Effect.sync(() => {
          events.push("record");
        }),
      interrupt: () =>
        Effect.sync(() => {
          events.push("interrupt");
        }),
    });
    assert.deepEqual(events, ["record", "interrupt"]);
    const failure = yield* interruptSurvivor({
      binding,
      recordStop: () => Effect.fail(new CodexDetachedAppServerError({ detail: "disk" })),
      interrupt: () =>
        Effect.sync(() => {
          events.push("unexpected interrupt");
        }),
    }).pipe(Effect.flip);
    assert.equal(
      failure.message,
      "GOAT could not record the stop of the Codex turn from before the restart",
    );
    assert.deepEqual(events, ["record", "interrupt"]);
  }),
);
