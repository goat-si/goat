import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as HostProcess from "@goat/shared/HostProcess";
import * as TestSourceControlHost from "@goat/source-control-testing/TestSourceControlHost";
import type * as SourceControlHost from "@goat/source-control-core/server/SourceControlHost";
import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import * as AzureDevOpsPullRequestCli from "./AzureDevOpsPullRequestCli.ts";
import { layer, mockedExecute, output } from "./azureDevOpsPullRequestCli.testkit.ts";

it.effect("passes a leading-at create title literally to az", () => {
  const run = vi.fn<SourceControlHost.SourceControlHost["Service"]["process"]["run"]>(() =>
    Effect.succeed(TestSourceControlHost.processOutput("{}")),
  );
  const support = Layer.mergeAll(
    TestSourceControlHost.layer({
      process: { run },
      git: { execute: () => Effect.succeed(TestSourceControlHost.processOutput("")) },
    }),
    NodeServices.layer,
    Layer.succeed(HostProcess.Platform, "linux"),
  );
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const bodyFile = yield* fs.makeTempFileScoped({ prefix: "goat-azure-test-body-" });
    yield* fs.writeFileString(bodyFile, "@/etc/hosts");
    const az = yield* AzureDevOpsCli.AzureDevOpsCli;
    yield* az.createPullRequest({
      cwd: "/repo",
      baseBranch: "main",
      headSelector: "feature",
      title: "@/etc/hosts",
      bodyFile,
    });
    const call = run.mock.calls.at(-1)?.[0];
    assert.equal(call?.stdin, "@/etc/hosts");
    assert.isTrue(call?.args.includes("--title=@-") ?? false);
    assert.isFalse(call?.args.includes("@/etc/hosts") ?? true);
  }).pipe(Effect.provide(AzureDevOpsCli.layer.pipe(Layer.provideMerge(support))), Effect.scoped);
});

it.effect("create preserves empty and multiline text without rereading the body as a path", () => {
  const sent: Array<{ title: string; body: string }> = [];
  const reads: string[] = [];
  const run = vi.fn<SourceControlHost.SourceControlHost["Service"]["process"]["run"]>((input) => {
    const titleArg = input.args.find((arg) => arg.startsWith("--title=")) ?? "";
    const bodyArg = input.args.find((arg) => arg.startsWith("--description=")) ?? "";
    const title = titleArg.slice("--title=".length);
    const bodyPath = bodyArg.slice("--description=@".length);
    reads.push(bodyPath);
    sent.push({ title: title === "@-" ? (input.stdin ?? "") : title, body: "@/etc/hosts" });
    return Effect.succeed(TestSourceControlHost.processOutput("{}"));
  });
  const support = Layer.mergeAll(
    TestSourceControlHost.layer({
      process: { run },
      git: { execute: () => Effect.succeed(TestSourceControlHost.processOutput("")) },
    }),
    NodeServices.layer,
    Layer.succeed(HostProcess.Platform, "linux"),
  );
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const bodyFile = yield* fs.makeTempFileScoped({ prefix: "goat-azure-test-body-" });
    yield* fs.writeFileString(bodyFile, "@/etc/hosts");
    const az = yield* AzureDevOpsCli.AzureDevOpsCli;
    for (const title of ["", "first\nsecond", "@/etc/hosts"]) {
      yield* az.createPullRequest({
        cwd: "/repo",
        baseBranch: "main",
        headSelector: "feature",
        title,
        bodyFile,
      });
    }
    assert.deepStrictEqual(
      sent,
      ["", "first\nsecond", "@/etc/hosts"].map((title) => ({ title, body: "@/etc/hosts" })),
    );
    assert.equal(reads.length, 3);
    for (const read of reads) assert.isFalse(yield* fs.exists(read));
  }).pipe(Effect.provide(AzureDevOpsCli.layer.pipe(Layer.provideMerge(support))), Effect.scoped);
});

layer("literal update", (it) => {
  it.effect("passes both leading-at fields through stdin", () =>
    Effect.gen(function* () {
      mockedExecute.mockReset();
      mockedExecute.mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;
      yield* cli.updatePullRequest({
        cwd: "/repo",
        number: 42,
        title: "@/etc/hosts",
        body: "@/etc/hosts",
      });
      assert.deepStrictEqual(
        mockedExecute.mock.calls.map(([call]) => call.stdin),
        ["@/etc/hosts", "@/etc/hosts"],
      );
      assert.isFalse(
        mockedExecute.mock.calls.some(
          ([call]) =>
            call.args.includes("--title=@/etc/hosts") ||
            call.args.includes("--description=@/etc/hosts"),
        ),
      );
    }),
  );

  it.effect("preserves empty and multiline update values", () =>
    Effect.gen(function* () {
      mockedExecute.mockReset();
      mockedExecute.mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;
      yield* cli.updatePullRequest({ cwd: "/repo", number: 42, title: "", body: "first\nsecond" });
      const call = mockedExecute.mock.calls[0]?.[0];
      assert.isTrue(call?.args.includes("--title=") ?? false);
      assert.isTrue(call?.args.includes("--description=first\nsecond") ?? false);
      assert.isUndefined(call?.stdin);
    }),
  );

  it.effect("surfaces a CLI failure and stops later updates", () =>
    Effect.gen(function* () {
      mockedExecute.mockReset();
      const error = new AzureDevOpsCli.AzureDevOpsCommandFailedError({
        operation: "execute",
        command: "az",
        cwd: "/repo",
        argumentCount: 0,
        cause: "failed",
      });
      mockedExecute.mockReturnValue(Effect.fail(error));
      const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;
      const result = yield* cli
        .updatePullRequest({ cwd: "/repo", number: 42, title: "@/etc/hosts", body: "@/etc/hosts" })
        .pipe(Effect.result);
      assert.isTrue(Result.isFailure(result));
      assert.equal(mockedExecute.mock.calls.length, 1);
    }),
  );
});
