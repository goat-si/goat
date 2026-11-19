import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { makeClaudeAttachmentBudget, reserveClaudePdfBudget } from "./ClaudeAttachmentBudget.ts";
import { makeClaudeAppContextDelivery } from "./ClaudeAppContext.ts";

it.effect(
  "bounds retained Claude app context and rejects oversized prompts before reserving bytes",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cache = makeClaudeAppContextDelivery();
        const budget = makeClaudeAttachmentBudget();
        const reservation = yield* reserveClaudePdfBudget(budget, Effect.void);
        const oversized = Array.from({ length: 65 }, (_, i) => ({
          key: `item-${i}`,
          text: "note",
        }));
        assert.equal(
          (yield* Effect.result(cache.prepare("overflow", "continue", oversized, reservation)))
            ._tag,
          "Failure",
        );
        assert.equal(reservation.bytes, 0);
        for (let i = 0; i < 65; i++) {
          const prepared = yield* cache.prepare(
            `session-${i}`,
            "continue",
            [{ key: "app", text: "note" }],
            reservation,
          );
          assert.isDefined(prepared);
          if (prepared === undefined) return;
          cache.commit(`session-${i}`, prepared.snapshot);
        }
        assert.isDefined(
          yield* cache.prepare(
            "session-0",
            "continue",
            [{ key: "app", text: "note" }],
            reservation,
          ),
        );
        assert.isUndefined(
          yield* cache.prepare(
            "session-64",
            "continue",
            [{ key: "app", text: "note" }],
            reservation,
          ),
        );
      }),
    ),
);

it.effect("respects the remaining Claude attachment budget for app context", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cache = makeClaudeAppContextDelivery();
      const budget = makeClaudeAttachmentBudget({ pagesUsed: 0, bytesUsed: 28 * 1024 * 1024 - 1 });
      const reservation = yield* reserveClaudePdfBudget(budget, Effect.void);
      assert.equal(
        (yield* Effect.result(
          cache.prepare("full", "continue", [{ key: "app", text: "note" }], reservation),
        ))._tag,
        "Failure",
      );
      assert.equal(reservation.bytes, 0);
    }),
  ),
);
