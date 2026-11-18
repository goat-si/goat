import { assert, it } from "@effect/vitest";
import { MessageId, ProjectId, ThreadId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "@goat/shared/composerContextReferences";

import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadSearch from "./ThreadSearch.ts";
import { at, createProject, layerTest, message, thread } from "./ThreadSearch.testkit.ts";

it.effect.each([true, false])(
  "ThreadSearch excludes bootstrap text before the hit and candidate limits (indexed: %s)",
  (indexed) =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const sql = yield* SqlClient.SqlClient;
      const project = ProjectId.make("project:attachments");
      const threadId = ThreadId.make("thread:attachments");
      yield* createProject(project);
      yield* Effect.forEach(
        [
          thread(threadId, project),
          message(threadId, "ordinary", "user", "Review the attached files in context", {
            minute: 1,
          }),
          message(threadId, "attachment", "user", ATTACHMENT_ONLY_BOOTSTRAP_PROMPT, { minute: 2 }),
          message(
            threadId,
            "ultrathink",
            "user",
            `Ultrathink:\n${ATTACHMENT_ONLY_BOOTSTRAP_PROMPT}`,
            { minute: 3 },
          ),
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
      assert.deepEqual((yield* search.search({ query: "conversation context" })).matches, []);
      assert.deepEqual((yield* search.search({ query: "ultrathink" })).matches, []);
      assert.deepEqual(
        (yield* search.search({ query: "attached files" })).matches.map((match) => [
          match.messageId,
          match.snippet,
        ]),
        [[MessageId.make("ordinary"), "Review the attached files in context"]],
      );
      for (const text of [
        ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
        `Ultrathink:\n${ATTACHMENT_ONLY_BOOTSTRAP_PROMPT}`,
        `uLtRaThInK:\r\n\t\u00a0${ATTACHMENT_ONLY_BOOTSTRAP_PROMPT}`,
      ]) {
        yield* sql`
          WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${indexed ? 10_000 : 2000})
          INSERT INTO orchestration_v2_projection_messages
            (message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
          SELECT 'attachment-limit:' || i, ${threadId}, 'user', 0,
            ${DateTime.formatIso(at(5))}, ${DateTime.formatIso(at(5))}, json_object('text', ${text})
          FROM n
        `;
        assert.deepEqual(
          (yield* search.search({ query: "context" })).matches.map((match) => match.messageId),
          [MessageId.make("ordinary")],
        );
        yield* sql`
          DELETE FROM orchestration_v2_projection_messages WHERE message_id LIKE 'attachment-limit:%'
        `;
      }
    }).pipe(Effect.provide(layerTest)),
);

it.effect("ThreadSearch excludes legacy placeholders still in the index", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const search = yield* ThreadSearch.ThreadSearch;
    const sql = yield* SqlClient.SqlClient;
    const project = ProjectId.make("project:legacy-attachments");
    const threadId = ThreadId.make("thread:legacy-attachments");
    yield* createProject(project);
    // Simulate the pre-upgrade trigger, which indexed attachment placeholders.
    yield* sql`DROP TRIGGER orchestration_v2_message_search_insert`;
    yield* sql`
      CREATE TRIGGER orchestration_v2_message_search_insert
      AFTER INSERT ON orchestration_v2_projection_messages
      BEGIN
        INSERT INTO orchestration_v2_message_search (rowid, text)
        VALUES (new.rowid, json_extract(new.payload_json, '$.text'));
      END
    `;
    yield* Effect.forEach(
      [
        thread(threadId, project),
        message(threadId, "ordinary", "user", "Review the attached files in context"),
        message(threadId, "attachment", "user", ATTACHMENT_ONLY_BOOTSTRAP_PROMPT),
        message(
          threadId,
          "ultrathink",
          "user",
          `uLtRaThInK:\r\n\t\u00a0${ATTACHMENT_ONLY_BOOTSTRAP_PROMPT}`,
        ),
      ],
      projections.apply,
      { discard: true },
    );
    assert.lengthOf(
      yield* sql`SELECT rowid FROM orchestration_v2_message_search WHERE orchestration_v2_message_search MATCH '"context"'`,
      3,
    );
    assert.deepEqual((yield* search.search({ query: "conversation context" })).matches, []);
    assert.deepEqual((yield* search.search({ query: "ultrathink" })).matches, []);
    assert.deepEqual(
      (yield* search.search({ query: "context" })).matches.map((match) => match.messageId),
      [MessageId.make("ordinary")],
    );
    yield* sql`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10000)
      INSERT INTO orchestration_v2_projection_messages
        (message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
      SELECT 'legacy-placeholder:' || i, ${threadId}, 'user', 0,
        ${DateTime.formatIso(at(5))}, ${DateTime.formatIso(at(5))},
        json_object('text', ${ATTACHMENT_ONLY_BOOTSTRAP_PROMPT}) FROM n
    `;
    assert.deepEqual(
      (yield* search.search({ query: "context" })).matches.map((match) => match.messageId),
      [MessageId.make("ordinary")],
    );
  }).pipe(Effect.provide(layerTest)),
);
