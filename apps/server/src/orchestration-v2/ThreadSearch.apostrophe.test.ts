import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadSearch from "./ThreadSearch.ts";
import { createProject, layerTest, message, thread } from "./ThreadSearch.testkit.ts";

// A two-character CJK word is too short for the index, so it scans even with the index.
it.effect.each([true, false])(
  "ThreadSearch finds a curly apostrophe for a straight one and back (indexed: %s)",
  (indexed) =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const sql = yield* SqlClient.SqlClient;
      const project = ProjectId.make("project:apostrophes");
      const curly = ThreadId.make("thread:apostrophe-curly");
      const straight = ThreadId.make("thread:apostrophe-straight");
      yield* createProject(project);
      yield* Effect.forEach(
        [
          thread(curly, project),
          message(curly, "apostrophe-curly", "user", "部署 the gannet\u2019s nest"),
          thread(straight, project),
          message(straight, "apostrophe-straight", "user", "部署 a kittiwake's nest"),
        ],
        projections.apply,
        { discard: true },
      );
      if (!indexed) {
        yield* sql`DROP TRIGGER orchestration_v2_message_search_insert`;
        yield* sql`DROP TRIGGER orchestration_v2_message_search_update`;
        yield* sql`DROP TRIGGER orchestration_v2_message_search_delete`;
        yield* sql`DROP TABLE orchestration_v2_message_search`;
      }
      const threadIds = (query: string) =>
        search.search({ query }).pipe(Effect.map(({ matches }) => matches.map((m) => m.threadId)));
      for (const query of ["gannet's", "部署 gannet's"]) {
        assert.deepEqual(yield* threadIds(query), [curly], query);
      }
      for (const query of ["kittiwake\u2019s", "部署 kittiwake\u2019s"]) {
        assert.deepEqual(yield* threadIds(query), [straight], query);
      }
    }).pipe(Effect.provide(layerTest)),
);
