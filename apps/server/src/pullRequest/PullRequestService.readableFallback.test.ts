import { ProjectId, SourceControlProviderKind } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { fakePullRequestProvider } from "@goat/source-control-testing/fakeSourceControlDriver";
import { PullRequestProviderError } from "@goat/source-control-core/server/PullRequestProvider";
import { makeService, project, unusable } from "./pullRequestTestFixtures.ts";

it.effect("retains an unavailable host's summary when it is the only queried host", () =>
  Effect.gen(function* () {
    for (const reason of ["missing-tool", "unauthenticated"] as const) {
      const service = yield* makeService({
        projects: [
          project({
            id: "p1",
            title: "t3code",
            workspaceRoot: "/a",
            repository: "pingdotgg/t3code",
          }),
        ],
        providers: [
          fakePullRequestProvider(SourceControlProviderKind.make("github"), {
            getViewer: () =>
              Effect.fail(unusable(SourceControlProviderKind.make("github"), reason)),
          }),
        ],
      });

      for (const filter of [{}, { host: "github.com" }]) {
        const error = yield* service.list({ state: "open", ...filter }).pipe(Effect.flip);
        assert.strictEqual(error._tag, "PullRequestUnavailableError");
        assert.strictEqual(
          error._tag === "PullRequestUnavailableError" ? error.reason : null,
          reason === "missing-tool" ? "cli-missing" : "cli-unauthenticated",
        );
        assert.isDefined(error.listResult);
        const result = error.listResult!;
        assert.deepStrictEqual(result.entries, []);
        assert.deepStrictEqual(result.viewers, {});
        assert.deepStrictEqual(
          result.providers.map(({ host, configured, projectIds }) => ({
            host,
            configured,
            projectIds: projectIds?.map(String),
          })),
          [{ host: "github.com", configured: false, projectIds: undefined }],
        );
        assert.strictEqual(result.providers[0]?.detail?.includes("github"), true);
        assert.deepStrictEqual(
          result.errors.map(({ projectId }) => projectId),
          ["p1"],
        );
      }
    }
  }),
);

it.effect("retains a Bitbucket host summary when the provider rejects saved credentials", () =>
  Effect.gen(function* () {
    const provider = fakePullRequestProvider(SourceControlProviderKind.make("bitbucket"), {
      getViewer: () =>
        Effect.fail(
          new PullRequestProviderError({
            provider: SourceControlProviderKind.make("bitbucket"),
            operation: "getViewer",
            reason: "failed",
            detail: "HTTP 403",
          }),
        ),
    });
    const service = yield* makeService({
      projects: [
        project({
          id: "bitbucket",
          title: "Widget",
          workspaceRoot: "/widget",
          repository: "acme/widget",
          provider: "bitbucket",
          host: "bitbucket.org",
        }),
      ],
      providers: [provider],
    });
    for (const filter of [{}, { host: "bitbucket.org" }]) {
      const error = yield* service.list({ state: "open", ...filter }).pipe(Effect.flip);
      assert.strictEqual(error._tag, "PullRequestOperationError");
      assert.isDefined(error.listResult);
      const result = error.listResult!;
      assert.deepStrictEqual(
        result.providers.map(({ host, configured, projectIds }) => ({
          host,
          configured,
          projectIds: projectIds?.map(String),
        })),
        [{ host: "bitbucket.org", configured: false, projectIds: undefined }],
      );
      assert.deepStrictEqual(result.entries, []);
      assert.deepStrictEqual(
        result.errors.map(({ projectId }) => projectId),
        ["bitbucket"],
      );
    }
  }),
);

it.effect.each([
  {
    provider: "forgejo",
    host: "ssh.forge.example",
    remoteUrl: "ssh://git@ssh.forge.example:2222/team/repo.git",
  },
  {
    provider: "unknown",
    host: "forge.example",
    remoteUrl: "http://forge.example:3000/team/repo.git",
  },
])(
  "identifies every worktree behind an unavailable refined Forgejo authority",
  ({ provider, host, remoteUrl }) =>
    Effect.gen(function* () {
      const service = yield* makeService({
        projects: ["ssh", "ssh-worktree"].map((id) =>
          project({
            id,
            title: id,
            workspaceRoot: `/${id}`,
            repository: "team/repo",
            provider,
            host,
            remoteUrl,
          }),
        ),
        providers: [
          fakePullRequestProvider(SourceControlProviderKind.make("forgejo"), {
            getViewer: ({ host }) => {
              assert.strictEqual(host, "forge.example:3000");
              return Effect.fail(
                unusable(SourceControlProviderKind.make("forgejo"), "unauthenticated"),
              );
            },
            listChangeRequests: () => Effect.die("An unauthenticated host must not be queried"),
          }),
        ],
        resolveHandle: ({ context }) =>
          Effect.succeed({
            context: {
              ...context!,
              provider: {
                kind: SourceControlProviderKind.make("forgejo"),
                name: "Forgejo",
                baseUrl: "http://forge.example:3000",
              },
            },
            provider: undefined as never,
          }),
      });
      const error = yield* service.list({ state: "open" }).pipe(Effect.flip);
      assert.isDefined(error.listResult);
      const result = error.listResult!;
      assert.deepStrictEqual(
        result.providers.map(({ host, configured, projectIds }) => ({
          host,
          configured,
          projectIds: projectIds?.map(String),
        })),
        [{ host: "forge.example:3000", configured: false, projectIds: ["ssh", "ssh-worktree"] }],
      );
      assert.deepStrictEqual(result.entries, []);
      assert.deepStrictEqual(
        result.errors.map(({ projectId }) => projectId),
        ["ssh"],
      );
    }),
);

// A list request names project ids, never repositories, so a server reads only its own projects.
it.effect("reads no repository for a project id this server does not have", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "goat", workspaceRoot: "/a", repository: "goat-si/goat" }),
      ],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
          listChangeRequests: () => Effect.die("A project this server lacks must not be read"),
        }),
      ],
    });
    const result = yield* service.list({
      state: "open",
      projectIds: [ProjectId.make("another-servers-project")],
    });
    assert.deepStrictEqual(result.entries, []);
    assert.deepStrictEqual(result.errors, []);
  }),
);
