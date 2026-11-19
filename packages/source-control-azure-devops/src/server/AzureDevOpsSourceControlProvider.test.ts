// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
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
    }).pipe(Effect.provide(AzureDevOpsCli.layer.pipe(Layer.provideMerge(support))));
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
  }).pipe(Effect.provide(AzureDevOpsCli.layer.pipe(Layer.provideMerge(support))));
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
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({}),
          TestSourceControlHost.layer(),
        ),
      ),
    ),
);

it.effect("checks out from the selected Azure remote when another remote appears first", () => {
  const remotes = [
    { name: "origin", url: "https://dev.azure.com/first/one/_git/repo" },
    { name: "upstream", url: "https://dev.azure.com/selected/two/_git/repo" },
  ];
  const selected = remotes[1]!;
  const commands: ReadonlyArray<string>[] = [];
  const fetched: string[] = [];
  const support = Layer.mergeAll(
    TestSourceControlHost.layer({
      process: {
        run: (input) => {
          commands.push(input.args);
          return Effect.succeed(
            processOutput(
              JSON.stringify({
                pullRequestId: 42,
                title: "Change",
                sourceRefName: "refs/heads/feature/x",
                targetRefName: "refs/heads/main",
                status: "active",
                _links: { web: { href: `${selected.url}/pullrequest/42` } },
              }),
            ),
          );
        },
      },
      git: {
        listLocalBranchNames: () => Effect.succeed([]),
        fetchRemoteBranch: (input) => {
          fetched.push(`${input.remoteName}/${input.remoteBranch}`);
          return Effect.void;
        },
        switchRef: (input) => Effect.succeed({ refName: input.refName }),
      },
    }),
    NodeServices.layer,
  );
  return Effect.gen(function* () {
    const cwd = yield* Effect.acquireRelease(
      Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-azure-remotes-"))),
      (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
    );
    const git = (...args: string[]) =>
      NodeChildProcess.execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
    git("init", "-q");
    for (const remote of remotes) git("remote", "add", remote.name, remote.url);
    assert.deepStrictEqual(git("remote").split("\n"), ["origin", "upstream"]);
    const selectedUrl = git("remote", "get-url", selected.name);
    const provider = yield* AzureDevOpsSourceControlProvider.make;
    yield* provider.checkoutChangeRequest({
      cwd,
      reference: "42",
      context: {
        provider: {
          kind: SourceControlProviderKind.make("azure-devops"),
          name: "Azure DevOps",
          baseUrl: "https://dev.azure.com",
        },
        remoteName: selected.name,
        remoteUrl: selectedUrl,
      },
    });
    assert.include(commands[0] ?? [], "--organization=https://dev.azure.com/selected");
    assert.include(commands[0] ?? [], "--project=two");
    assert.deepStrictEqual(fetched, ["upstream/feature/x"]);
  }).pipe(Effect.scoped, Effect.provide(AzureDevOpsCli.layer.pipe(Layer.provideMerge(support))));
});

it.effect(
  "refuses to fetch when the PR belongs to a different repository on the selected project",
  () => {
    const fetched: string[] = [];
    const host = TestSourceControlHost.layer({
      git: {
        fetchRemoteBranch: (input) => {
          fetched.push(input.remoteName);
          return Effect.void;
        },
      },
    });
    const cli = Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({
      getPullRequest: () =>
        Effect.succeed({
          number: 42,
          title: "Other repository",
          url: "https://dev.azure.com/selected/two/_git/other/pullrequest/42",
          baseRefName: "main",
          headRefName: "feature/x",
          state: "open",
          isCrossRepository: false,
          closedAt: null,
          mergedAt: null,
          updatedAt: Option.none(),
        }),
    });
    return Effect.gen(function* () {
      const provider = yield* AzureDevOpsSourceControlProvider.make;
      const result = yield* provider
        .checkoutChangeRequest({
          cwd: "/repo",
          reference: "42",
          context: {
            provider: {
              kind: SourceControlProviderKind.make("azure-devops"),
              name: "Azure DevOps",
              baseUrl: "https://dev.azure.com",
            },
            remoteName: "upstream",
            remoteUrl: "https://dev.azure.com/selected/two/_git/repo",
          },
        })
        .pipe(Effect.result);
      assert.isTrue(result._tag === "Failure");
      assert.deepStrictEqual(fetched, []);
    }).pipe(Effect.provide(Layer.mergeAll(host, cli)));
  },
);
