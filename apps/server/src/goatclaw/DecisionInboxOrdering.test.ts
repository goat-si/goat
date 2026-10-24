import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Inbox from "./DecisionInbox.ts";
import { fixture, seedDestination, transport } from "./DecisionDestination.testkit.ts";

it.effect(
  "baseline-failing #1405: limited pages keep the same tie order as the SQL candidates",
  () =>
    Effect.gen(function* () {
      for (const id of ["a", "Z", "["]) yield* seedDestination({ id });
      const inbox = yield* Inbox.DecisionInbox;
      expect((yield* inbox.list(transport, { limit: 1 })).items.map((item) => item.id)).toEqual([
        "decision:Z",
      ]);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE decision_items SET status = 'withdrawn'`;
      expect(
        (yield* inbox.list(transport, { limit: 1, status: "open" })).items.map((item) => item.id),
      ).toEqual(["pending:Z:question-Z"]);
    }).pipe(Effect.provide(fixture())),
);
