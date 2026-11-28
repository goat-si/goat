import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadSearch from "./ThreadSearch.ts";
import { createProject, layerTest, message, thread } from "./ThreadSearch.testkit.ts";

it.layer(layerTest)("ThreadSearch ranking", (it) => {
  it.effect("keeps a better title match over a weaker one found by its messages", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const project = ProjectId.make("project:heron");
      yield* createProject(project);
      // Six titled threads that each also name the word in a message.
      yield* Effect.forEach(
        Array.from({ length: 6 }, (_, index) => {
          const id = ThreadId.make(`thread:heron-${index + 1}`);
          return [
            thread(id, project, { title: `Heron ${index + 1}` }),
            message(id, `heron-${index + 1}`, "user", "a heron sighting", { minute: 2 }),
          ];
        }).flat(),
        projections.apply,
        { discard: true },
      );
      const byTitle = (yield* search.searchThreads({ query: "heron", limit: 6 })).matches;
      assert.deepStrictEqual(
        byTitle.map((match) => match.source),
        Array.from({ length: 6 }, () => "title"),
      );
      const { matches } = yield* search.searchThreads({ query: "heron", limit: 5 });
      assert.deepStrictEqual(
        matches.map((match) => match.threadId),
        byTitle.slice(0, 5).map((match) => match.threadId),
      );
    }),
  );
});
