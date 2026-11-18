import { afterEach, assert, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as GitHubPullRequestApi from "./GitHubPullRequestApi.ts";
import {
  callAt,
  defaultCredential,
  diffRefused,
  layer,
  mockedCredential,
  mockedExecute,
  mockedStackMemberships,
  output,
  pathAt,
  pullRequestFiles,
} from "./GitHubPullRequestApi.testkit.ts";

afterEach(() => {
  mockedExecute.mockReset();
  mockedStackMemberships.mockReset();
  mockedCredential.mockReset();
  mockedCredential.mockImplementation(defaultCredential);
});

layer("GitHub pull request diffs", (it) => {
  it.effect("reads one files page when GitHub refuses the diff, and says it is the last", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.fail(diffRefused));
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequestFiles(2, 1))));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const diff = yield* cli.getPullRequestDiff({
        cwd: "/w",
        repository: "acme/web",
        host: "github.acme.dev",
        number: 7,
      });

      assert.isFalse(diff.truncated);
      assert.isNull(diff.nextCursor);
      expect(diff.patch).toContain("diff --git a/src/file1.ts b/src/file1.ts");
      expect(diff.patch).toContain("diff --git a/src/file2.ts b/src/file2.ts");
      assert.strictEqual(callAt(1).host, "github.acme.dev");
      assert.strictEqual(pathAt(1), "repos/acme/web/pulls/7/files?per_page=100&page=1");
    }),
  );

  it.effect("hands back a cursor for the next page rather than walking on by itself", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.fail(diffRefused));
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequestFiles(100, 0))));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const diff = yield* cli.getPullRequestDiff({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      assert.isFalse(diff.truncated);
      assert.isNotNull(diff.nextCursor);
      assert.strictEqual(mockedExecute.mock.calls.length, 2);
    }),
  );

  it.effect("refuses a cursor it never handed out rather than reading it into a request", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const error = yield* Effect.flip(
        cli.getPullRequestDiff({
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          cursor: "1&per_page=1",
        }),
      );

      assert.strictEqual(error._tag, "GitHubDiffCursorError");
      assert.strictEqual(mockedExecute.mock.calls.length, 0);
    }),
  );

  it.effect("pages an oversized patch by file rather than handing back a severed one", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output("diff --git a/a b/a\n@@ -1 +1 @@", true)),
      );
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequestFiles(1, 1))));
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;

      const slice = yield* cli.getPullRequestDiff({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      assert.strictEqual(pathAt(1), "repos/acme/web/pulls/7/files?per_page=100&page=1");
      expect(slice.patch).toContain("src/file1.ts");
      expect(slice.patch).not.toContain("diff --git a/a b/a");
      assert.strictEqual(mockedExecute.mock.calls.length, 2);
    }),
  );

  it.effect("extracts only the named file and bounds long lines at the named commit", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const ref = {
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        commit: "b".repeat(40),
      };
      const header =
        'diff --git "a/old.js" "b/new.js"\nsimilarity index 80%\nrename from old.js\nrename to new.js\n@@ -1 +1 @@\n';
      const patch =
        "diff --git a/other b/other\n@@ -1 +1 @@\n-old\n+new\n" +
        header +
        "-old\n+" +
        "x".repeat(1200) +
        "\n";
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(patch)));
      assert.strictEqual(
        (yield* cli.getPullRequestDiff({ ...ref, path: "new.js" })).patch,
        header + "-old\n+" + "x".repeat(1000) + " …[200 more characters]\n",
      );
      assert.strictEqual(pathAt(0), "repos/acme/web/commits/" + ref.commit);

      mockedExecute.mockReturnValueOnce(Effect.succeed(output(patch)));
      const wrongPath = yield* Effect.flip(cli.getPullRequestDiff({ ...ref, path: "old.js" }));
      assert.strictEqual(wrongPath._tag, "GitHubPullRequestReadError");

      mockedExecute.mockReturnValueOnce(Effect.succeed(output(patch, true)));
      const incomplete = yield* Effect.flip(cli.getPullRequestDiff({ ...ref, path: "new.js" }));
      assert.strictEqual(incomplete._tag, "GitHubPullRequestReadError");
    }),
  );

  it.effect(
    "rejects a displaced PR head and reads matching refs through an immutable comparison",
    () =>
      Effect.gen(function* () {
        const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
        const base = "a".repeat(40);
        const head = "b".repeat(40);
        const input = {
          cwd: "/w",
          repository: "acme/web",
          host: "github.com",
          number: 7,
          path: "large.js",
          revision: { baseSha: base, headSha: head },
        };
        mockedExecute.mockReturnValueOnce(
          Effect.succeed(
            output(JSON.stringify({ base: { sha: base }, head: { sha: "c".repeat(40) } })),
          ),
        );
        const mismatch = yield* Effect.flip(cli.getPullRequestDiff(input));
        assert.strictEqual(mismatch._tag, "GitHubPullRequestReadError");
        assert.lengthOf(mockedExecute.mock.calls, 1);

        const patch = "diff --git a/large.js b/large.js\n@@ -1 +1 @@\n-before\n+after\n";
        mockedExecute.mockReturnValueOnce(
          Effect.succeed(output(JSON.stringify({ base: { sha: base }, head: { sha: head } }))),
        );
        mockedExecute.mockReturnValueOnce(Effect.succeed(output(patch)));
        assert.strictEqual((yield* cli.getPullRequestDiff(input)).patch, patch);
        assert.strictEqual(pathAt(2), "repos/acme/web/compare/" + base + "..." + head);
      }),
  );
  it.effect("advertises an aggregate file only from the page's immutable comparison", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const ref = { cwd: "/w", repository: "acme/web", host: "github.com", number: 7 };
      const revision = { baseSha: "a".repeat(40), headSha: "b".repeat(40) };
      const omitted = (filename: string) => [{ filename, status: "modified", additions: 2 }];
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(output("partial", true)))
        .mockReturnValueOnce(Effect.succeed(output(JSON.stringify(omitted("mutable.js")))))
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              JSON.stringify({
                base: { sha: revision.baseSha },
                head: { sha: revision.headSha },
              }),
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(output(JSON.stringify({ files: omitted("pinned.js") }))),
        );
      const page = yield* cli.getPullRequestDiff(ref);
      expect(page).toMatchObject({
        revision,
        withheldFilesReadable: true,
        omittedFileStats: [{ path: "pinned.js" }],
      });
      expect(page.patch).not.toContain("mutable.js");
      expect(pathAt(3)).toBe(
        "repos/acme/web/compare/" + revision.baseSha + "..." + revision.headSha + "?per_page=1",
      );
    }),
  );

  it.effect("refuses aggregate file reads without a pair or after just the base moves", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const ref = {
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        path: "large.js",
      };
      const patch = "diff --git a/large.js b/large.js\n@@ -1 +1 @@\n-before\n+after\n";
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(patch)));
      expect((yield* Effect.result(cli.getPullRequestDiff(ref)))._tag).toBe("Failure");
      expect(mockedExecute).not.toHaveBeenCalled();
      mockedExecute.mockReset();
      const revision = { baseSha: "a".repeat(40), headSha: "b".repeat(40) };
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              JSON.stringify({
                base: { sha: "c".repeat(40) },
                head: { sha: revision.headSha },
              }),
            ),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(output(patch)));
      expect((yield* Effect.result(cli.getPullRequestDiff({ ...ref, revision })))._tag).toBe(
        "Failure",
      );
      expect(mockedExecute).toHaveBeenCalledTimes(1);
    }),
  );
  it.effect("pins a revision-bound review to the checked head and refuses an advanced base", () =>
    Effect.gen(function* () {
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const revision = { baseSha: "a".repeat(40), headSha: "b".repeat(40) };
      const input = {
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        verdict: "comment" as const,
        body: "",
        revision,
        comments: [
          { body: "review", path: "large.js", position: { kind: "added" as const, newLine: 1 } },
        ],
      };
      const answer = (baseSha: string) =>
        output(JSON.stringify({ base: { sha: baseSha }, head: { sha: revision.headSha } }));
      mockedExecute.mockReturnValueOnce(Effect.succeed(answer("c".repeat(40))));
      expect((yield* Effect.result(cli.submitReview(input)))._tag).toBe("Failure");
      expect(callAt(0)).toMatchObject({ kind: "rest", path: "repos/acme/web/pulls/7" });

      mockedExecute.mockReturnValueOnce(Effect.succeed(answer(revision.baseSha)));
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("{}")));
      yield* cli.submitReview(input);
      expect(callAt(2)).toMatchObject({
        kind: "rest",
        method: "POST",
        path: "repos/acme/web/pulls/7/reviews",
        body: { commit_id: revision.headSha },
      });
    }),
  );
});
