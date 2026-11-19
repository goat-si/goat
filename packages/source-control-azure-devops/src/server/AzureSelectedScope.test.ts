import { GitCommandError, SourceControlProviderKind } from "@goat/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@goat/shared/HostProcess";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { processOutput } from "@goat/source-control-testing/TestSourceControlHost";
import * as TestSourceControlHost from "@goat/source-control-testing/TestSourceControlHost";
import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import * as AzureDevOpsPullRequestCli from "./AzureDevOpsPullRequestCli.ts";
import * as Provider from "./AzureDevOpsSourceControlProvider.ts";

it.effect("scopes selected-remote Azure list operations to that organization and project", () => {
  const commands: ReadonlyArray<string>[] = [];
  const support = Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(HostProcess.Platform, "linux"),
    TestSourceControlHost.layer({
      process: {
        run: (input) => {
          commands.push(input.args);
          return Effect.succeed(processOutput("[]"));
        },
      },
      git: { execute: () => Effect.succeed(processOutput("origin\n")) },
    }),
  );
  return Effect.gen(function* () {
    const provider = yield* Provider.make;
    yield* provider.listChangeRequests({
      cwd: "/repo",
      headSelector: "feature",
      state: "open",
      context: {
        provider: {
          kind: SourceControlProviderKind.make("azure-devops"),
          name: "Azure",
          baseUrl: "https://dev.azure.com",
        },
        remoteName: "upstream",
        remoteUrl: "ssh://git@ssh.dev.azure.com/v3/Selected/My%20Project/Repo",
      },
    });
    assert.include(commands[0] ?? [], "--organization");
    assert.include(commands[0] ?? [], "https://dev.azure.com/Selected");
    assert.include(commands[0] ?? [], "--project=My Project");
    assert.include(commands[0] ?? [], "--repository=Repo");
    assert.include(commands[0] ?? [], "false");
  }).pipe(Effect.provide(AzureDevOpsCli.layer.pipe(Layer.provideMerge(support))));
});

it.effect("keeps the PR read argv byte-identical and does not inspect git remotes", () => {
  const commands: ReadonlyArray<string>[] = [];
  const support = Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(HostProcess.Platform, "linux"),
    TestSourceControlHost.layer({
      process: {
        run: (input) => {
          commands.push(input.args);
          return Effect.succeed(processOutput("{}"));
        },
      },
      git: { execute: () => Effect.die("PR read must not inspect git") },
    }),
  );
  return Effect.gen(function* () {
    const cli = yield* AzureDevOpsPullRequestCli.make;
    yield* cli.getPullRequest({ cwd: "/repo", number: 42 }).pipe(Effect.result);
    assert.deepStrictEqual(commands, [
      [
        "repos",
        "pr",
        "show",
        "--detect",
        "true",
        "--id",
        "42",
        "--only-show-errors",
        "--output",
        "json",
      ],
    ]);
  }).pipe(Effect.provide(AzureDevOpsCli.layer.pipe(Layer.provideMerge(support))));
});

it.effect.each(["primary", "other-host", "malformed", "failed", "config-failed"] as const)(
  "resolves an implicit Azure scope when the remote is %s",
  (mode) => {
    const commands: ReadonlyArray<string>[] = [];
    const gitCalls: string[] = [];
    const support = Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(HostProcess.Platform, "linux"),
      TestSourceControlHost.layer({
        process: {
          run: (input) => {
            commands.push(input.args);
            return Effect.succeed(processOutput("[]"));
          },
        },
        git: {
          execute: (input) => {
            gitCalls.push(input.args.join(" "));
            if (mode === "failed")
              return Effect.fail(
                new GitCommandError({
                  operation: "test",
                  command: "git remote",
                  cwd: "/repo",
                  detail: "failed",
                }),
              );
            if (input.args[0] === "remote")
              return Effect.succeed(processOutput("origin\nupstream\n"));
            if (mode === "config-failed")
              return Effect.fail(
                new GitCommandError({
                  operation: "test",
                  command: "git config",
                  cwd: "/repo",
                  detail: "failed",
                }),
              );
            const url =
              mode === "primary"
                ? "https://dev.azure.com/chosen/Project/_git/Repo"
                : mode === "other-host"
                  ? "https://github.com/a/b/_git/repo"
                  : "https://dev.azure.com/invalid";
            return Effect.succeed(processOutput(`${url}\n`));
          },
          resolvePrimaryRemoteName: () => Effect.succeed("upstream"),
        },
      }),
    );
    return Effect.gen(function* () {
      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      const action = az.listPullRequests({ cwd: "/repo", headSelector: "feature", state: "open" });
      if (mode === "failed" || mode === "config-failed") {
        const error = yield* Effect.flip(action);
        assert.strictEqual(error._tag, "AzureDevOpsCommandFailedError");
        assert.deepStrictEqual(commands, []);
        return;
      }
      yield* action;
      assert.include(gitCalls, "config --get-all remote.upstream.url");
      if (mode === "primary") {
        assert.include(commands[0] ?? [], "https://dev.azure.com/chosen");
        assert.include(commands[0] ?? [], "--project=Project");
      } else {
        const detect = commands[0]?.indexOf("--detect") ?? -1;
        assert.strictEqual(commands[0]?.[detect + 1], "true");
      }
    }).pipe(Effect.provide(AzureDevOpsCli.layer.pipe(Layer.provideMerge(support))));
  },
);
