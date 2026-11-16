import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Inbox from "./DecisionInbox.ts";
import { fixture, seedPending } from "./DecisionDestination.testkit.ts";

const owner: Inbox.DecisionCaller = {
  kind: "client",
  sessionId: "owner",
  environmentId: EnvironmentId.make("test"),
  scopes: ["orchestration:operate", "settings:write"],
  resolver: { kind: "person" },
};

it.effect("a closed question's inbox item reads withdrawn, an answered one answered", () =>
  Effect.gen(function* () {
    yield* seedPending();
    const inbox = yield* Inbox.DecisionInbox;
    const sql = yield* SqlClient.SqlClient;
    const { id } = (yield* inbox.list(owner, { status: "open" })).items[0]!;
    for (const [decision, status] of [
      ["cancel", "withdrawn"],
      [null, "answered"],
    ] as const) {
      yield* sql`UPDATE orchestration_v2_projection_runtime_requests
        SET status = 'resolved', resolved_at = '1970-01-01T00:00:01.000Z',
          payload_json = ${decision === null ? "{}" : JSON.stringify({ decision })}`;
      expect((yield* inbox.get(owner, id)).status).toBe(status);
    }
  }).pipe(Effect.provide(fixture())),
);
