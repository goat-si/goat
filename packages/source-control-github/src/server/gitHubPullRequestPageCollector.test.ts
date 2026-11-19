import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { collectGitHubPages } from "./gitHubPullRequestPageCollector.ts";

it.effect("stops a zero-row page even when the host supplies a new cursor", () =>
  Effect.gen(function* () {
    let calls = 0;
    const result = yield* collectGitHubPages(10, () => {
      calls++;
      if (calls > 1) return Effect.die("requested another zero-progress page");
      return Effect.succeed({ items: [], rawCount: 0, endCursor: `cursor-${calls}` });
    });
    expect(calls).toBe(1);
    expect(result.truncated).toBe(true);
  }),
);

it.effect("stops at a bounded page count when every page advances slowly", () =>
  Effect.gen(function* () {
    let calls = 0;
    const result = yield* collectGitHubPages(1000, () => {
      calls++;
      if (calls > 100) return Effect.die("exceeded page cap");
      return Effect.succeed({ items: [calls], rawCount: 1, endCursor: `cursor-${calls}` });
    });
    expect(calls).toBe(100);
    expect(result.truncated).toBe(true);
  }),
);
