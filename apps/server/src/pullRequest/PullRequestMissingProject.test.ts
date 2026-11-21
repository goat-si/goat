import { expect, it } from "@effect/vitest";
import { SourceControlProviderKind, type ProjectId } from "@goat/contracts";
import { fakePullRequestProvider } from "@goat/source-control-testing/fakeSourceControlDriver";
import * as Effect from "effect/Effect";
import { makeService, project, changeRequest } from "./pullRequestTestFixtures.ts";
import { PullRequestProviderError } from "@goat/source-control-core/server/PullRequestProvider";

it.effect("distinguishes a host without a project and does not name projects on other hosts", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({
          id: "caller",
          title: "secret-other-project",
          workspaceRoot: "/caller",
          repository: "other/private",
        }),
      ],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("github")),
        fakePullRequestProvider(SourceControlProviderKind.make("gitlab"), {
          servesHost: (host) => host === "gitlab.com",
        }),
      ],
    });
    const result = yield* service
      .summary(
        {
          projectId: "caller" as ProjectId,
          host: "gitlab.com",
          repository: "team/private",
          number: 7,
        },
        { recoverTransientFailure: false },
      )
      .pipe(Effect.flip);
    expect(result).toMatchObject({
      _tag: "PullRequestUnavailableError",
      reason: "provider-unsupported",
      detail: "no-project-on-host",
    });
    expect(result.message).not.toContain("secret-other-project");
    const unknown = yield* service
      .summary(
        {
          projectId: "caller" as ProjectId,
          host: "unknown.invalid",
          repository: "team/private",
          number: 7,
        },
        { recoverTransientFailure: false },
      )
      .pipe(Effect.flip);
    expect(unknown).toMatchObject({
      _tag: "PullRequestUnavailableError",
      reason: "provider-unsupported",
    });
    expect(unknown).not.toHaveProperty("detail");
  }),
);

it.effect(
  "keeps checkoutless reads on the selected environment and preserves private or offline failures",
  () =>
    Effect.gen(function* () {
      const caller = project({
        id: "caller",
        title: "caller",
        workspaceRoot: "/caller",
        repository: "other/repo",
      });
      let outcome: "ok" | "not-found" | "failed" = "ok";
      const seen: string[] = [];
      const service = yield* makeService({
        projects: [caller],
        providers: [
          fakePullRequestProvider(SourceControlProviderKind.make("github"), {
            readsPublicHostWithoutCheckout: true,
            getChangeRequestSummary: (input) => {
              seen.push(`${input.cwd}:${input.host}:${input.repository}`);
              return outcome === "ok"
                ? Effect.succeed(changeRequest(7, "2026-07-02T00:00:00Z"))
                : Effect.fail(
                    new PullRequestProviderError({
                      provider: SourceControlProviderKind.make("github"),
                      operation: "summary",
                      reason: outcome,
                      detail: "host read failed",
                    }),
                  );
            },
          }),
        ],
      });
      const ref = {
        projectId: caller.id,
        host: "github.com",
        repository: "team/private",
        number: 7,
      };
      expect(
        (yield* service.summary(ref, { recoverTransientFailure: false, bypassCache: true })).number,
      ).toBe(7);
      for (const failure of ["not-found", "failed"] as const) {
        outcome = failure;
        const error = yield* service
          .summary(ref, { recoverTransientFailure: false, bypassCache: true })
          .pipe(Effect.flip);
        expect(error._tag).toBe("PullRequestOperationError");
        expect(error.message).not.toContain("Add a project");
      }
      expect(seen).toEqual(Array(3).fill("/caller:github.com:team/private"));
    }),
);

it.effect("requires a matching project only for a host the keyed provider serves", () =>
  Effect.gen(function* () {
    const caller = project({
      id: "caller",
      title: "caller",
      workspaceRoot: "/caller",
      repository: "other/repo",
    });
    const azure = fakePullRequestProvider(SourceControlProviderKind.make("azure-devops"), {
      repositoryKey: ({ canonicalKey }) => canonicalKey,
      servesHost: (host) => host === "dev.azure.com",
    });
    const service = yield* makeService({
      projects: [caller],
      providers: [fakePullRequestProvider(SourceControlProviderKind.make("github")), azure],
    });
    const result = yield* service
      .summary(
        {
          projectId: caller.id,
          host: "dev.azure.com",
          repository: "org/team/_git/repo",
          number: 5,
        },
        { recoverTransientFailure: false },
      )
      .pipe(Effect.flip);
    expect(result).toMatchObject({
      _tag: "PullRequestUnavailableError",
      reason: "provider-unsupported",
      detail: "repository-not-added",
    });
    expect(result.message).toContain("repository as a project");
  }),
);
