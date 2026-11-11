import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestSourceControlHost from "@goat/source-control-testing/TestSourceControlHost";

import * as ForgejoCli from "./ForgejoCli.ts";
import * as ForgejoSourceControlProvider from "./ForgejoSourceControlProvider.ts";

const processOutput = TestSourceControlHost.processOutput;
const encodeJsonEffect = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

it.effect("finds a merged Forgejo pull request whose head branch was deleted", () =>
  Effect.gen(function* () {
    const provider = yield* ForgejoSourceControlProvider.make;
    const found = yield* provider.listChangeRequests({
      cwd: "/repo",
      headSelector: "feature",
      state: "merged",
    });
    assert.deepStrictEqual(
      found.map((pr) => [pr.number, pr.headRefName]),
      [[7, "feature"]],
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(FileSystem.FileSystem, FileSystem.makeNoop({})),
        TestSourceControlHost.layer({ process: {} }),
        Layer.mock(ForgejoCli.ForgejoCli)({
          resolveRepository: () =>
            Effect.succeed({
              login: "work",
              repository: "maria/project",
              baseUrl: "https://forgejo.test",
            }),
          api: (input) => {
            const repo = { full_name: "maria/project", owner: { login: "maria" } };
            const page = new URLSearchParams(input.path.split("?")[1]).get("page");
            return encodeJsonEffect(
              page === "1"
                ? [
                    {
                      number: 7,
                      title: "Merged feature",
                      html_url: "https://forgejo.test/maria/project/pulls/7",
                      state: "closed",
                      merged: true,
                      merged_at: "2026-10-12T00:00:00Z",
                      base: { ref: "main", label: "main", sha: "base", repo },
                      head: { ref: "refs/pull/7/head", label: "feature", sha: "head", repo },
                    },
                    {
                      number: 8,
                      title: "Merged from a deleted fork",
                      html_url: "https://forgejo.test/maria/project/pulls/8",
                      state: "closed",
                      merged: true,
                      merged_at: "2026-10-11T00:00:00Z",
                      base: { ref: "main", label: "main", sha: "base", repo },
                      head: { ref: "refs/pull/8/head", label: "feature", sha: "fork", repo: null },
                    },
                    {
                      number: 9,
                      title: "AGit topic",
                      html_url: "https://forgejo.test/maria/project/pulls/9",
                      state: "closed",
                      merged: true,
                      merged_at: "2026-10-10T00:00:00Z",
                      flow: 1,
                      base: { ref: "main", label: "main", sha: "base", repo },
                      head: { ref: "refs/pull/9/head", label: "feature", sha: "topic", repo },
                    },
                  ]
                : [],
            ).pipe(Effect.orDie, Effect.map(processOutput));
          },
        }),
      ),
    ),
  ),
);
