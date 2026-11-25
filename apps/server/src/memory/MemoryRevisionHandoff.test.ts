import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { revisionHandoff } from "./memoryRevisionHandoff.testkit.ts";
import { scoreTicket } from "../../scripts/memoryHandoffScore.ts";

it.effect("compares reads of the same edited memory before and after indexing", () =>
  Effect.gen(function* () {
    const f = yield* revisionHandoff("old-fixture", "new-fixture");
    assert.notEqual(f.oldRevision, f.currentRevision);
    for (const [o, ids, coverage] of [
      [f.initial, [f.oldRevision], "complete"],
      [f.pending, [], "partial"],
      [f.indexed, [f.currentRevision], "complete"],
    ] as const) {
      assert.equal(o.result.indexCoverage.status, coverage);
      assert.deepStrictEqual(
        o.result.items.map((i) => i.revisionId),
        [...ids],
      );
      assert.deepStrictEqual(
        o.receipt.events.map((e) => [e.kind, e.items.map((i) => i.revisionId)]),
        [["recall", [...ids]]],
      );
      assert.isFalse(Boolean(o.receipt.incomplete || o.receipt.truncated));
    }
    assert.equal(f.initial.result.items[0]?.relation, "project_thread");
    assert.include(f.indexed.result.items[0]?.text, "new-fixture");
  }),
);

it("scores a ticket against the current head and the evidence actually supplied", () => {
  const grade = (answer: string, currentSupplied: boolean) =>
    scoreTicket(answer, { current: "new", previous: "old", currentSupplied });
  assert.equal(grade('{"acceptanceCode":"new"}', true), "grounded-current");
  assert.equal(grade('{"acceptanceCode":"new"}', false), "unsupported-current");
  assert.equal(grade('{"acceptanceCode":"old"}', true), "stale");
  assert.equal(grade('{"acceptanceCode":"old"}', false), "stale");
  assert.equal(grade('{"acceptanceCode":null}', false), "abstained");
  assert.equal(grade('{"acceptanceCode":null}', true), "missed-current");
  assert.equal(grade('{"acceptanceCode":"something else"}', true), "wrong-code");
  assert.equal(grade('{"acceptanceCode":"new","old":"old"}', true), "invalid-ticket");
  assert.equal(grade("new", true), "invalid-ticket");
});
