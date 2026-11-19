import type { ProjectId } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { environmentViewedService } from "./pullRequestTestFixtures.ts";

const GITLAB_REFERENCE = {
  projectId: "p1" as ProjectId,
  repository: "group/project",
  number: 1,
};

it.effect("reports a file pushed to after the diff the reader ticked was drawn as changed", () =>
  Effect.gen(function* () {
    const revisions = new Map([["src/a.ts", "shown-a"]]);
    const service = yield* environmentViewedService(revisions, []);

    yield* service.filesViewed(GITLAB_REFERENCE);
    yield* TestClock.adjust("61 seconds");
    revisions.set("src/a.ts", "pushed-a");
    yield* service.setFilesViewed({
      ...GITLAB_REFERENCE,
      files: [{ path: "src/a.ts", viewed: true, revision: "shown-a" }],
    });
    yield* service.invalidate({ reference: GITLAB_REFERENCE });

    assert.deepStrictEqual((yield* service.filesViewed(GITLAB_REFERENCE)).files, [
      { path: "src/a.ts", state: "dismissed" },
    ]);
  }),
);

it.effect(
  "records the head's version of a file ticked without a revision, as older clients send",
  () =>
    Effect.gen(function* () {
      const revisions = new Map([["src/a.ts", "shown-a"]]);
      const service = yield* environmentViewedService(revisions, []);

      yield* service.filesViewed(GITLAB_REFERENCE);
      yield* TestClock.adjust("61 seconds");
      revisions.set("src/a.ts", "pushed-a");
      yield* service.setFilesViewed({
        ...GITLAB_REFERENCE,
        files: [{ path: "src/a.ts", viewed: true }],
      });
      yield* service.invalidate({ reference: GITLAB_REFERENCE });

      assert.deepStrictEqual((yield* service.filesViewed(GITLAB_REFERENCE)).files, [
        { path: "src/a.ts", state: "viewed" },
      ]);
    }),
);
