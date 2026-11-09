import * as NodeServices from "@effect/platform-node/NodeServices";
import { SourceControlProviderKind } from "@goat/contracts";
import type * as SourceControlHost from "@goat/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@goat/source-control-testing/TestSourceControlHost";
import { processOutput } from "@goat/source-control-testing/TestSourceControlHost";
import { assert, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/process";

import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import * as AzureDevOpsSourceControlProvider from "./AzureDevOpsSourceControlProvider.ts";

const { parseAuth } = AzureDevOpsSourceControlProvider.discovery;

it("reads the signed-in Azure account and says when az is signed out", () => {
  assert.deepStrictEqual(parseAuth(processOutput("azure-user@example.com\n")), {
    status: "authenticated",
    account: Option.some("azure-user@example.com"),
    host: Option.some("dev.azure.com"),
    detail: Option.none(),
  });
  assert.strictEqual(
    parseAuth(
      processOutput("", {
        stderr: "Please run 'az login' to setup account.\n",
        exitCode: ChildProcessSpawner.ExitCode(1),
      }),
    ).status,
    "unauthenticated",
  );
  assert.strictEqual(parseAuth(processOutput("\n")).status, "unknown");
});

it.effect(
  "names the remote's organization, project, and repository when reading the default branch",
  () => {
    const run = vi.fn<SourceControlHost.SourceControlHost["Service"]["process"]["run"]>(() =>
      Effect.succeed(
        processOutput(
          JSON.stringify({
            name: "My Repo",
            webUrl: "https://dev.azure.com/acme/project/_git/My%20Repo",
            remoteUrl: "https://dev.azure.com/acme/project/_git/My%20Repo",
            sshUrl: "git@ssh.dev.azure.com:v3/acme/project/My%20Repo",
            defaultBranch: "refs/heads/master",
          }),
        ),
      ),
    );
    const support = Layer.mergeAll(
      TestSourceControlHost.layer({ process: { run } }),
      NodeServices.layer,
    );
    return Effect.gen(function* () {
      const provider = yield* AzureDevOpsSourceControlProvider.make;
      for (const [remoteUrl, repository, project, organization] of [
        [
          "https://acme@dev.azure.com/acme/project/_git/My%20Repo",
          "My Repo",
          "project",
          "https://dev.azure.com/acme",
        ],
        [
          "https://dev.azure.com/acme/project/_git/My%20Repo?view=x#readme",
          "My Repo",
          "project",
          "https://dev.azure.com/acme",
        ],
        [
          "https://acme.visualstudio.com/DefaultCollection/project/_git/My%20Repo/",
          "My Repo",
          "project",
          "https://acme.visualstudio.com",
        ],
        [
          "git@ssh.dev.azure.com:v3/acme/project/My%20Repo",
          "My Repo",
          "project",
          "https://dev.azure.com/acme",
        ],
        [
          "ssh://git@ssh.dev.azure.com/v3/acme/project/My%20Repo",
          "My Repo",
          "project",
          "https://dev.azure.com/acme",
        ],
        [
          "https://dev.azure.com/acme/project/_git/service.git",
          "service.git",
          "project",
          "https://dev.azure.com/acme",
        ],
        ["https://dev.azure.com/acme/project/_git/-repo", null, null, null],
        [
          "ssh://git@vs-ssh.visualstudio.com/v3/acme/project/My%20Repo",
          "My Repo",
          "project",
          "https://dev.azure.com/acme",
        ],
        [
          "git@vs-ssh.visualstudio.com:v3/acme/project/My%20Repo",
          "My Repo",
          "project",
          "https://dev.azure.com/acme",
        ],
        ["https://dev.azure.com/acme/project/_git/%40.env", null, null, null],
        ["https://dev.azure.com/acme/%40.env/_git/My%20Repo", null, null, null],
        ["https://dev.azure.com/acme/-alpha/_git/My%20Repo", null, null, null],
        ["https://dev.azure.com/-acme/project/_git/My%20Repo", null, null, null],
      ] as const) {
        run.mockClear();
        const branch = yield* provider.getDefaultBranch({
          cwd: "/repo",
          context: {
            provider: {
              kind: SourceControlProviderKind.make("azure-devops"),
              name: "Azure DevOps",
              baseUrl: "https://dev.azure.com",
            },
            remoteName: "origin",
            remoteUrl,
          },
        });
        if (repository === null) {
          assert.strictEqual(branch, null, remoteUrl);
          assert.strictEqual(run.mock.calls.length, 0, remoteUrl);
          continue;
        }
        assert.strictEqual(branch, "master", remoteUrl);
        const args = [...(run.mock.calls[0]?.[0].args ?? [])];
        assert.include(args, `--repository=${repository}`, remoteUrl);
        assert.include(args, `--project=${project}`, remoteUrl);
        assert.include(args, `--organization=${organization}`, remoteUrl);
      }
    }).pipe(Effect.provide(AzureDevOpsCli.layer.pipe(Layer.provide(support))));
  },
);

it.effect("follows the selected remote's project when another one is detected", () => {
  const run = vi.fn<SourceControlHost.SourceControlHost["Service"]["process"]["run"]>(() =>
    Effect.succeed(
      processOutput(
        JSON.stringify({
          name: "My Repo",
          webUrl: "https://dev.azure.com/acme/selected/_git/My%20Repo",
          remoteUrl: "https://dev.azure.com/acme/selected/_git/My%20Repo",
          sshUrl: "git@ssh.dev.azure.com:v3/acme/selected/My%20Repo",
          defaultBranch: "refs/heads/master",
        }),
      ),
    ),
  );
  const support = Layer.mergeAll(
    TestSourceControlHost.layer({ process: { run } }),
    NodeServices.layer,
  );
  return Effect.gen(function* () {
    const provider = yield* AzureDevOpsSourceControlProvider.make;
    // The same repository name in two projects: only the selected remote says which one.
    for (const project of ["selected", "detected"]) {
      run.mockClear();
      yield* provider.getDefaultBranch({
        cwd: "/repo",
        context: {
          provider: {
            kind: SourceControlProviderKind.make("azure-devops"),
            name: "Azure DevOps",
            baseUrl: "https://dev.azure.com",
          },
          remoteName: "upstream",
          remoteUrl: `https://dev.azure.com/acme/${project}/_git/My%20Repo`,
        },
      });
      const args = [...(run.mock.calls[0]?.[0].args ?? [])];
      assert.include(args, `--project=${project}`, project);
    }
  }).pipe(Effect.provide(AzureDevOpsCli.layer.pipe(Layer.provide(support))));
});

it.effect(
  "looks up a branch's pull requests a full page at a time, past forks' same-named branches",
  () =>
    Effect.gen(function* () {
      const provider = yield* AzureDevOpsSourceControlProvider.make;
      assert.deepStrictEqual(
        provider.headBranchProbe?.({
          headSelectors: ["octocat:feature", "feature"],
          state: "open",
        }),
        { headSelectors: ["feature"], limit: 100 },
      );
    }).pipe(Effect.provide(Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({}))),
);
