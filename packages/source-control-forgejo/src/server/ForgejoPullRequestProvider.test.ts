import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestSourceControlHost from "@goat/source-control-testing/TestSourceControlHost";

import * as ForgejoCli from "./ForgejoCli.ts";
import * as ForgejoPullRequestProvider from "./ForgejoPullRequestProvider.ts";
import { markRequiredForgejoChecks } from "./forgejoRequiredChecks.ts";

it("matches many-wildcard required patterns against long check names without backtracking", () => {
  const checks = ["a".repeat(200), `${"a".repeat(199)}b`, "x?y\nz"].map((name) => ({
    name,
    status: "success" as const,
    description: null,
    url: null,
  }));
  const marked = markRequiredForgejoChecks(checks, {
    enable_status_check: true,
    status_check_contexts: [`${"*a".repeat(12)}b`, "x*?y?z"],
  });
  assert.deepStrictEqual(
    marked.map((check) => [check.name.slice(-3), check.required]),
    [
      ["aaa", undefined],
      ["aab", true],
      ["y\nz", true],
    ],
  );
});

it("treats a required pattern's `*` as a wildcard even when the check name has one", () => {
  const checks = ["*build", "ci/*lint"].map((name) => ({
    name,
    status: "success" as const,
    description: null,
    url: null,
  }));
  const marked = markRequiredForgejoChecks(checks, {
    enable_status_check: true,
    status_check_contexts: ["*build", "ci/*"],
  });
  assert.deepStrictEqual(
    marked.map((check) => [check.name, check.required]),
    [
      ["*build", true],
      ["ci/*lint", true],
    ],
  );
});

it.effect("reads file revisions from the pull request diff and refuses a truncated one", () =>
  Effect.gen(function* () {
    let truncated = false;
    const diff = [
      "diff --git a/alpha.ts b/alpha.ts",
      "index eb2d7c5..b485fe5 100644",
      "diff --git a/beta.ts b/beta.ts",
      "index b39e8b3..5851425 100644",
      'diff --git "a/caf\\303\\251 notes.txt" "b/caf\\303\\251 notes.txt"',
      "index ffd99ce..6dd9855 100644",
      "diff --git a/deleted.txt b/deleted.txt",
      "deleted file mode 100644",
      "index 233f5c6..0000000",
      "diff --git a/old.txt b/renamed.txt",
      "similarity index 100%",
      "rename from old.txt",
      "rename to renamed.txt",
      "",
    ].join("\n");
    const provider = yield* ForgejoPullRequestProvider.make.pipe(
      Effect.provide(
        Layer.mock(ForgejoCli.ForgejoCli)({
          api: (input) => {
            assert.strictEqual(input.host, "forge.example:3000");
            assert.strictEqual(input.repository, "reviewer/project");
            assert.strictEqual(input.path, "repos/reviewer/project/pulls/1.diff");
            return Effect.succeed({
              ...TestSourceControlHost.processOutput(diff),
              stdoutTruncated: truncated,
            });
          },
        }),
      ),
    );
    const reference = {
      cwd: "/forgejo",
      repository: "reviewer/project",
      host: "forge.example:3000",
      number: 1,
    };
    const paths = ["alpha.ts", "beta.ts", "café notes.txt", "deleted.txt", "renamed.txt"];
    assert.isDefined(provider.getFileRevisions);
    const answer = yield* provider.getFileRevisions!({ ...reference, paths });
    assert.isTrue(answer.complete);
    assert.deepStrictEqual(
      paths.map((path) => [path, answer.revisions.get(path)]),
      [
        ["alpha.ts", "b485fe5"],
        ["beta.ts", "5851425"],
        ["café notes.txt", "6dd9855"],
        ["deleted.txt", "0000000"],
        ["renamed.txt", ""],
      ],
    );

    truncated = true;
    const refused = yield* Effect.flip(provider.getFileRevisions!({ ...reference, paths }));
    assert.strictEqual(refused._tag, "PullRequestProviderError");
  }),
);
