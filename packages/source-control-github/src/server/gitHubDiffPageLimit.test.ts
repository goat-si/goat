import { assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as GitHubPullRequestApi from "./GitHubPullRequestApi.ts";
import {
  defaultCredential,
  diffRefused,
  layer,
  mockedCredential,
  mockedExecute,
  output,
  pathAt,
  pullRequestFiles,
} from "./GitHubPullRequestApi.testkit.ts";

layer("GitHub diff pagination", (it) => {
  it.effect("returns a cursor for a full page of thirty files", () =>
    Effect.gen(function* () {
      mockedExecute.mockReset();
      mockedCredential.mockReset();
      mockedCredential.mockImplementation(defaultCredential);
      mockedExecute.mockReturnValueOnce(Effect.fail(diffRefused));
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequestFiles(30, 0))));
      const api = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const page = yield* api.getPullRequestDiff({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });
      assert.equal(pathAt(1), "repos/acme/web/pulls/7/files?per_page=30&page=1");
      assert.equal(page.nextCursor, "2");
      assert.isFalse(page.truncated);
    }),
  );

  it.effect("marks a full hundredth page truncated without a further cursor", () =>
    Effect.gen(function* () {
      mockedExecute.mockReset();
      mockedCredential.mockReset();
      mockedCredential.mockImplementation(defaultCredential);
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(pullRequestFiles(30, 2970))));
      const api = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const page = yield* api.getPullRequestDiff({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        cursor: "100",
      });
      assert.isTrue(page.truncated);
      assert.isNull(page.nextCursor);
    }),
  );
});
