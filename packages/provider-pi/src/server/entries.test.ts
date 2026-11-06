import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { readPiEntries } from "./entries.ts";

it.effect("follows OmO history pages and preserves their entries and leaf", () =>
  Effect.gen(function* () {
    const requests: unknown[] = [];
    const result = yield* readPiEntries(true, (input) => {
      requests.push(input);
      return Effect.succeed(
        requests.length === 1
          ? { entries: [{ id: "a" }], leafId: "b", hasMore: true, nextSince: "a" }
          : { entries: [{ id: "b" }], leafId: "b", hasMore: false },
      );
    });
    assert.deepEqual(result, { entries: [{ id: "a" }, { id: "b" }], leafId: "b" });
    assert.equal((requests[1] as { since?: string }).since, "a");
  }),
);

it.effect("fails an OmO history response that cannot advance", () =>
  Effect.gen(function* () {
    const result = yield* Effect.result(
      readPiEntries(true, () =>
        Effect.succeed({
          entries: [],
          leafId: null,
          hasMore: true,
        }),
      ),
    );
    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) assert.include(result.failure.message, "get_entries");
  }),
);
