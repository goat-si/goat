import { GitCommandError } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as BitbucketApi from "./BitbucketApi.ts";
import { makeLayer } from "./BitbucketApi.testkit.ts";

const bitbucketPullRequest = {
  id: 42,
  title: "Add Bitbucket provider",
  state: "OPEN",
  updated_on: "2026-01-02T00:00:00.000Z",
  links: {
    html: {
      href: "https://bitbucket.org/goat-si/goat/pull-requests/42",
    },
  },
  source: {
    branch: { name: "feature/source-control" },
    repository: {
      full_name: "octocat/goat",
      workspace: { slug: "octocat" },
    },
  },
  destination: {
    branch: { name: "main" },
    repository: {
      full_name: "goat-si/goat",
      workspace: { slug: "goat-si" },
    },
  },
};

const repositoryJson = {
  full_name: "goat-si/goat",
  links: {
    html: { href: "https://bitbucket.org/goat-si/goat" },
    clone: [
      { name: "https", href: "https://bitbucket.org/goat-si/goat.git" },
      { name: "ssh", href: "git@bitbucket.org:goat-si/goat.git" },
    ],
  },
  mainbranch: { name: "main" },
};

const gitOutput = (stdout: string) => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

it.effect.each(["multiple", "missing", "failed"] as const)(
  "uses the first fetch URL or the HTTPS fallback when config is %s",
  (mode) => {
    const { git, layer } = makeLayer({
      git: {
        execute: () =>
          mode === "failed"
            ? Effect.fail(
                new GitCommandError({
                  operation: "test",
                  cwd: "/repo",
                  command: "git config",
                  detail: "unavailable",
                }),
              )
            : Effect.succeed(
                gitOutput(
                  mode === "missing"
                    ? ""
                    : "https://bitbucket.org/goat-si/goat.git\ngit@bitbucket.org:goat-si/goat.git\n",
                ),
              ),
      },
      response: (request) =>
        Response.json(
          request.url.endsWith("/pullrequests/42")
            ? bitbucketPullRequest
            : {
                ...repositoryJson,
                full_name: "octocat/goat",
                links: {
                  clone: [
                    { name: "https", href: "https://bitbucket.org/octocat/goat.git" },
                    { name: "ssh", href: "git@bitbucket.org:octocat/goat.git" },
                  ],
                },
              },
        ),
    });
    return Effect.gen(function* () {
      const bitbucket = yield* BitbucketApi.BitbucketApi;
      yield* bitbucket.checkoutPullRequest({ cwd: "/repo", reference: "#42" });
      assert.deepStrictEqual(git.ensureRemote.mock.calls[0]?.[0], {
        cwd: "/repo",
        preferredName: "octocat",
        url: "https://bitbucket.org/octocat/goat.git",
      });
    }).pipe(Effect.provide(layer));
  },
);
