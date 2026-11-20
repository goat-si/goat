import { assert, it } from "@effect/vitest";
import { GitCommandError } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { processOutput } from "@goat/source-control-testing/TestSourceControlHost";
import * as TestSourceControlHost from "@goat/source-control-testing/TestSourceControlHost";
import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import * as Provider from "./AzureDevOpsSourceControlProvider.ts";

it.effect.each(["multiple", "single", "missing", "failed"] as const)(
  "handles %s Azure fetch URLs",
  (mode) => {
    const scopes: Array<{ organization: string | undefined; project: string | undefined }> = [];
    return Effect.gen(function* () {
      const provider = yield* Provider.make;
      if (mode === "missing" || mode === "failed") {
        const error = yield* Effect.flip(
          provider.checkoutChangeRequest({ cwd: "/repo", reference: "42" }),
        );
        assert.strictEqual(error._tag, "SourceControlProviderError");
        assert.deepStrictEqual(scopes, []);
        return;
      }
      yield* provider.checkoutChangeRequest({ cwd: "/repo", reference: "42" });
      assert.deepStrictEqual(scopes, [
        { organization: "https://dev.azure.com/first", project: "project" },
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({
            getPullRequest: (input) => {
              scopes.push({ organization: input.organization, project: input.project });
              return Effect.succeed({
                url: "https://dev.azure.com/first/project/_git/repo/pullrequest/42",
                isCrossRepository: false,
                headRefName: "feature",
              } as never);
            },
          }),
          TestSourceControlHost.layer({
            git: {
              resolvePrimaryRemoteName: () => Effect.succeed("origin"),
              readConfigValue: () => Effect.succeed("https://dev.azure.com/last/project/_git/repo"),
              execute: () =>
                mode === "failed"
                  ? Effect.fail(
                      new GitCommandError({
                        operation: "test",
                        command: "git config",
                        cwd: "/repo",
                        detail: "failed",
                      }),
                    )
                  : Effect.succeed(
                      processOutput(
                        mode === "missing"
                          ? ""
                          : `https://dev.azure.com/first/project/_git/repo\n${mode === "multiple" ? "https://dev.azure.com/last/project/_git/repo\n" : ""}`,
                      ),
                    ),
              listLocalBranchNames: () => Effect.succeed([]),
              fetchRemoteBranch: () => Effect.void,
              switchRef: (input) => Effect.succeed({ refName: input.refName }),
            },
          }),
        ),
      ),
    );
  },
);
