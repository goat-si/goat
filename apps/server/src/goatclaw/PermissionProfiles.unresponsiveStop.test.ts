import { expect, it } from "@effect/vitest";
import { ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { PermissionProfiles } from "./PermissionProfiles.ts";
import { fixture, outside, seed } from "./PermissionProfiles.testkit.ts";

// A Stop the provider never confirms leaves the child's run running, so the lane stays taken
// until whatever ends that run: the provider finishing, its unload, or a person's Force stop.
it.effect.each(["completed", "interrupted", "failed"] as const)(
  "a child whose Stop went unanswered holds its lane until its run ends as %s",
  (ended) =>
    Effect.gen(function* () {
      const profiles = yield* PermissionProfiles;
      const sql = yield* SqlClient.SqlClient;
      for (const id of ["a", "b", "c"]) {
        yield* profiles.claim(outside, {
          id,
          childThreadId: ThreadId.make(id),
          runtimeMode: "full-access",
        });
        yield* seed(id);
        yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
        VALUES (${`run:${id}`}, ${id}, 1, 'codex', 'running', '2026-10-21', '{}')`;
        yield* profiles.complete(id);
      }
      const nextLane = profiles.claim(outside, { id: "d", runtimeMode: "full-access" });
      expect((yield* nextLane.pipe(Effect.flip)).code).toBe("capability_denied");
      yield* sql`UPDATE orchestration_v2_projection_runs SET status = ${ended} WHERE thread_id = 'a'`;
      expect((yield* nextLane).enabled).toBe(true);
    }).pipe(Effect.provide(fixture())),
);
