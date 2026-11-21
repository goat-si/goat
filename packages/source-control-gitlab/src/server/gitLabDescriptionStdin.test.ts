import { assert, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import * as Result from "effect/Result";
import type * as SourceControlHost from "@goat/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@goat/source-control-testing/TestSourceControlHost";
import * as GitLabCli from "./GitLabCli.ts";

it.effect("sends the merge request description over stdin", () => {
  const run = vi.fn<SourceControlHost.SourceControlHost["Service"]["process"]["run"]>(() =>
    Effect.succeed(TestSourceControlHost.processOutput("{}")),
  );
  const host = TestSourceControlHost.layer({ process: { run } });
  return Effect.gen(function* () {
    const bodyFile = "/fake/body.md";
    const cli = yield* GitLabCli.make.pipe(Effect.provide(host));
    yield* cli.createMergeRequest({
      cwd: "/repo",
      baseBranch: "main",
      headSelector: "feature",
      title: "Title",
      bodyFile,
    });
    const call = run.mock.calls[0]?.[0];
    assert.equal(call?.stdin, "@/etc/hosts\nsecond line\n");
    assert.isTrue(call?.args.includes("description=@-") ?? false);
    assert.isFalse(call?.args.some((arg) => arg.includes(bodyFile)) ?? true);
  }).pipe(
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        stream: () => Stream.make(new TextEncoder().encode("@/etc/hosts\nsecond line\n")),
      }),
    ),
    Effect.scoped,
  );
});

it.effect("sends an empty description as empty stdin", () => {
  const run = vi.fn<SourceControlHost.SourceControlHost["Service"]["process"]["run"]>(() =>
    Effect.succeed(TestSourceControlHost.processOutput("{}")),
  );
  const host = TestSourceControlHost.layer({ process: { run } });
  return Effect.gen(function* () {
    const cli = yield* GitLabCli.make.pipe(Effect.provide(host));
    yield* cli.createMergeRequest({
      cwd: "/repo",
      baseBranch: "main",
      headSelector: "feature",
      title: "Title",
      bodyFile: "/fake/empty",
    });
    assert.equal(run.mock.calls[0]?.[0].stdin, "");
  }).pipe(
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({ stream: () => Stream.empty }),
    ),
    Effect.scoped,
  );
});

it.effect("reports an unreadable description without starting glab", () => {
  const run = vi.fn<SourceControlHost.SourceControlHost["Service"]["process"]["run"]>(() =>
    Effect.succeed(TestSourceControlHost.processOutput("{}")),
  );
  const host = TestSourceControlHost.layer({ process: { run } });
  const failure = new PlatformError.PlatformError(
    new PlatformError.SystemError({
      _tag: "NotFound",
      module: "FileSystem",
      method: "open",
      pathOrDescriptor: "/fake/missing",
    }),
  );
  return Effect.gen(function* () {
    const cli = yield* GitLabCli.make.pipe(Effect.provide(host));
    const result = yield* cli
      .createMergeRequest({
        cwd: "/repo",
        baseBranch: "main",
        headSelector: "feature",
        title: "Title",
        bodyFile: "/fake/missing",
      })
      .pipe(Effect.result);
    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) {
      assert.equal(result.failure._tag, "GitLabCliCommandError");
      assert.include(result.failure.detail, "could not be read");
    }
    assert.equal(run.mock.calls.length, 0);
  }).pipe(
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({ stream: () => Stream.fail(failure) }),
    ),
    Effect.scoped,
  );
});

it.effect("rejects an oversized description before invoking glab", () => {
  const run = vi.fn<SourceControlHost.SourceControlHost["Service"]["process"]["run"]>(() =>
    Effect.succeed(TestSourceControlHost.processOutput("{}")),
  );
  const host = TestSourceControlHost.layer({ process: { run } });
  return Effect.gen(function* () {
    const bodyFile = "/fake/body.md";
    const cli = yield* GitLabCli.make.pipe(Effect.provide(host));
    const result = yield* cli
      .createMergeRequest({
        cwd: "/repo",
        baseBranch: "main",
        headSelector: "feature",
        title: "Title",
        bodyFile,
      })
      .pipe(Effect.result);
    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) assert.include(result.failure.detail, "too large");
    assert.equal(run.mock.calls.length, 0);
  }).pipe(
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        stream: () => Stream.make(new TextEncoder().encode("a".repeat(4_000_001))),
      }),
    ),
    Effect.scoped,
  );
});
