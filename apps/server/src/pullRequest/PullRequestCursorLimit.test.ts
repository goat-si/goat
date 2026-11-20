import { expect, it } from "@effect/vitest";
import { SourceControlProviderKind } from "@goat/contracts";
import { fakePullRequestProvider } from "@goat/source-control-testing/fakeSourceControlDriver";
import * as Effect from "effect/Effect";
import { changeRequest, makeService, project } from "./pullRequestTestFixtures.ts";

it.effect(
  "reports truncation without a repeating cursor when a timestamp has more than the identity cap",
  () =>
    Effect.gen(function* () {
      const service = yield* makeService({
        projects: [
          project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" }),
        ],
        providers: [
          fakePullRequestProvider(SourceControlProviderKind.make("github"), {
            listChangeRequestsAcross: () =>
              Effect.succeed({
                items: Array.from({ length: 129 }, (_, i) => ({
                  ...changeRequest(i + 1, "2026-07-02T00:00:00Z"),
                  repository: "acme/web",
                })),
                truncated: true,
              }),
          }),
        ],
      });
      const result = yield* service.list({ state: "open", limit: 129 });
      expect(result.entries).toHaveLength(129);
      expect(new Set(result.entries.map((entry) => entry.number)).size).toBe(129);
      expect(result.truncated).toBe(true);
      expect(result.nextCursors).toEqual({});
    }),
);
