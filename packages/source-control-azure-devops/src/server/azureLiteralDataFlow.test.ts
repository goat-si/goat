// @effect-diagnostics nodeBuiltinImport:off -- run a fake az executable with actual pipes and files.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { VcsProcessExitError } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type * as SourceControlHost from "@goat/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@goat/source-control-testing/TestSourceControlHost";
import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import * as AzureDevOpsPullRequestCli from "./AzureDevOpsPullRequestCli.ts";

const script = `const fs = require('node:fs');
const argv = process.argv.slice(2);
const stdin = fs.readFileSync(0, 'utf8');
const reads = [];
const values = {};
for (const arg of argv) {
  const match = /^(--[^=]+)=@(.+)$/.exec(arg) || (arg.startsWith('@') ? ['','argument',arg.slice(1)] : null);
  if (!match) continue;
  if (match[2] === '-') values[match[1]] = stdin;
  else { reads.push(match[2]); values[match[1]] = match[2] === '/etc/hosts' ? '[blocked]' : fs.readFileSync(match[2], 'utf8'); }
}
process.stdout.write(JSON.stringify({ argv, stdin, reads, values }));`;

it.live(
  "passes literal create and update fields through a real fake az process and cleans the bounded file",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "goat-az-dataflow-" });
      const fake = NodePath.join(cwd, "fake-az.cjs");
      const bodyFile = NodePath.join(cwd, "body.md");
      NodeFS.writeFileSync(fake, script);
      NodeFS.writeFileSync(bodyFile, "@/etc/hosts");
      const records: Array<{
        argv: string[];
        stdin: string;
        reads: string[];
        values: Record<string, string>;
      }> = [];
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const run: SourceControlHost.SourceControlHost["Service"]["process"]["run"] = (input) =>
        Effect.gen(function* () {
          const child = yield* spawner.spawn(
            ChildProcess.make(NodeProcess.execPath, [fake, ...input.args], { cwd }),
          );
          const [chunks] = yield* Effect.all(
            [
              Stream.runCollect(child.stdout),
              Stream.run(Stream.encodeText(Stream.make(input.stdin ?? "")), child.stdin),
            ],
            { concurrency: 2 },
          );
          yield* child.exitCode;
          const decoder = new TextDecoder();
          const stdout =
            chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join("") +
            decoder.decode();
          records.push(JSON.parse(stdout));
          return TestSourceControlHost.processOutput("{}");
        }).pipe(Effect.scoped, Effect.orDie);
      const host = TestSourceControlHost.layer({
        process: { run },
        git: { execute: () => Effect.succeed(TestSourceControlHost.processOutput("")) },
      });
      const azure = yield* AzureDevOpsCli.make.pipe(Effect.provide(host));
      yield* azure.createPullRequest({
        cwd,
        baseBranch: "main",
        headSelector: "@feature",
        title: "@/etc/hosts",
        bodyFile,
      });
      const created = records[0]!;
      assert.equal(created.values["--title"], "@/etc/hosts");
      assert.equal(created.values["--description"], "@/etc/hosts");
      assert.lengthOf(created.reads, 1);
      assert.notEqual(created.reads[0], bodyFile);
      assert.include(created.argv, `--description=@${created.reads[0]}`);
      assert.include(created.argv, "--title=@-");
      assert.include(created.argv, "--source-branch=refs/heads/@feature");
      assert.isFalse(NodeFS.existsSync(created.reads[0]!));
      const update = yield* AzureDevOpsPullRequestCli.make.pipe(
        Effect.provideService(AzureDevOpsCli.AzureDevOpsCli, azure),
      );
      yield* update.updatePullRequest({
        cwd,
        number: 42,
        title: "@/etc/hosts",
        body: "@/etc/hosts",
      });
      assert.deepStrictEqual(
        records.slice(1).map((record) => record.stdin),
        ["@/etc/hosts", "@/etc/hosts"],
      );
      assert.equal(records[1]?.values["--title"], "@/etc/hosts");
      assert.equal(records[2]?.values["--description"], "@/etc/hosts");
      assert.isTrue(records.slice(1).every((record) => record.reads.length === 0));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.live("rejects a body above four million bytes before az reads a file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "goat-az-limit-" });
    const bodyFile = NodePath.join(cwd, "body.md");
    NodeFS.writeFileSync(bodyFile, "a".repeat(4_000_001));
    let calls = 0;
    const host = TestSourceControlHost.layer({
      process: {
        run: () => {
          calls++;
          return Effect.succeed(TestSourceControlHost.processOutput("{}"));
        },
      },
      git: { execute: () => Effect.succeed(TestSourceControlHost.processOutput("")) },
    });
    const azure = yield* AzureDevOpsCli.make.pipe(Effect.provide(host));
    const result = yield* azure
      .createPullRequest({
        cwd,
        baseBranch: "main",
        headSelector: "feature",
        title: "Title",
        bodyFile,
      })
      .pipe(Effect.result);
    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) {
      assert.equal(result.failure._tag, "AzureDevOpsCommandFailedError");
      assert.include(result.failure.detail, "too large");
    }
    assert.equal(calls, 0);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.live.each(["failure", "interrupt"] as const)("removes the bounded temp file on CLI %s", (mode) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "goat-az-cleanup-" });
    const bodyFile = NodePath.join(cwd, "body.md");
    yield* fs.writeFileString(bodyFile, "@/etc/hosts");
    const started = yield* Deferred.make<string>();
    const host = TestSourceControlHost.layer({
      process: {
        run: (input) => {
          const arg = input.args.find((entry) => entry.startsWith("--description=@"));
          const temp = arg?.slice("--description=@".length) ?? "";
          return Deferred.succeed(started, temp).pipe(
            Effect.andThen(
              mode === "interrupt"
                ? Effect.never
                : Effect.fail(
                    new VcsProcessExitError({
                      operation: input.operation,
                      command: input.command,
                      cwd: input.cwd,
                      exitCode: 1,
                      detail: "fake failure",
                    }),
                  ),
            ),
          );
        },
      },
      git: { execute: () => Effect.succeed(TestSourceControlHost.processOutput("")) },
    });
    const azure = yield* AzureDevOpsCli.make.pipe(Effect.provide(host));
    const action = yield* azure
      .createPullRequest({
        cwd,
        baseBranch: "main",
        headSelector: "feature",
        title: "@/etc/hosts",
        bodyFile,
      })
      .pipe(Effect.forkChild);
    const temp = yield* Deferred.await(started);
    assert.isTrue(yield* fs.exists(temp));
    if (mode === "interrupt") yield* Fiber.interrupt(action);
    else assert.isTrue(Result.isFailure(yield* Fiber.join(action).pipe(Effect.result)));
    assert.isFalse(yield* fs.exists(temp));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
