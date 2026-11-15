import { assert, it } from "@effect/vitest";
import { EnvironmentId, MessageId, ProjectId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { serializeAssistantCitation } from "@goat/shared/assistantCitations";

import { rebuildMessageSearch } from "./messageSearchIndex.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadSearch from "./ThreadSearch.ts";
import { createProject, layerTest, message, thread } from "./ThreadSearch.testkit.ts";

// The prefix and suffix are hidden selection context, not text the reader sees.
const quote = serializeAssistantCitation({
  version: 1,
  environmentId: EnvironmentId.make("environment:local"),
  threadId: ThreadId.make("thread:quoted"),
  messageId: MessageId.make("quoted-answer"),
  text: "A lighthouse guides ships safely through the darkness.",
  comment: "what are you talking about",
  start: 0,
  end: 54,
  prefix: "beacon01",
  suffix: "harbor",
});

it.layer(layerTest)("ThreadSearch over quotes", (it) => {
  it.effect("matches the readable text of quotes and their comments", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const project = ProjectId.make("project:search-citation");
      const threadId = ThreadId.make("thread:citation");
      yield* createProject(project);
      yield* Effect.forEach(
        [
          thread(threadId, project),
          message(threadId, "citation", "user", `${quote} quiet silver lantern`),
        ],
        projections.apply,
        { discard: true },
      );
      const snippets = (query: string) =>
        Effect.map(search.search({ query }), (result) =>
          result.matches
            .filter((match) => match.threadId === threadId)
            .map((match) => match.snippet),
        );

      const readable =
        "A lighthouse guides ships safely through the darkness. Comment: what are you talking about quiet silver lantern";
      assert.deepEqual(yield* snippets("what are you talking about"), [
        `…${readable.slice(readable.indexOf("the darkness"))}`,
      ]);
      assert.deepEqual(yield* snippets("ships safely through"), [readable]);
      assert.deepEqual(yield* snippets("beacon01"), []);
      assert.deepEqual(yield* snippets("harbor"), []);

      yield* projections.apply(message(threadId, "citation", "user", "quiet silver lantern"));
      assert.deepEqual(yield* snippets("what are you talking about"), []);
      assert.deepEqual(yield* snippets("lantern"), ["quiet silver lantern"]);
    }),
  );

  it.effect("finds accented, CJK, and apostrophe words of a quote through the index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const project = ProjectId.make("project:search-citation-index");
      const threadId = ThreadId.make("thread:citation-index");
      // The stored link percent-encodes these words; the index must hold them as they read.
      const encodedQuote = serializeAssistantCitation({
        version: 1,
        environmentId: EnvironmentId.make("environment:local"),
        threadId: ThreadId.make("thread:quoted"),
        messageId: MessageId.make("quoted-answer"),
        text: "The kittiwake's résumé mentions 灯台の光 twice.",
        comment: "naïve question в логах",
        start: 0,
        end: 44,
        prefix: "",
        suffix: "",
      });
      yield* createProject(project);
      yield* Effect.forEach(
        [thread(threadId, project), message(threadId, "citation-index", "user", encodedQuote)],
        projections.apply,
        { discard: true },
      );
      const index = yield* sql`
        SELECT 1 FROM sqlite_master WHERE name = 'orchestration_v2_message_search'
      `;
      assert.lengthOf(index, 1);
      const threadIds = (query: string) =>
        search.search({ query }).pipe(Effect.map(({ matches }) => matches.map((m) => m.threadId)));

      for (const query of [
        "kittiwake's",
        "kittiwake’s",
        "résumé",
        "灯台の光",
        "naïve",
        "логах в",
      ]) {
        assert.deepEqual(yield* threadIds(query), [threadId], query);
      }
      // `goat doctor` rebuilds the index after VACUUM; quotes must still read.
      yield* rebuildMessageSearch(sql);
      assert.deepEqual(yield* threadIds("résumé"), [threadId]);

      yield* projections.apply(message(threadId, "citation-index", "user", "plain words"));
      assert.deepEqual(yield* threadIds("résumé"), []);
      assert.deepEqual(yield* threadIds("plain"), [threadId]);
    }),
  );
});
