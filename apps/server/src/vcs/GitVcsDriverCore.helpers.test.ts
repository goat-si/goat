import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, describe } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import {
  makeGitVcsDriverCore,
  existingBranchConflictDetail,
  isSameWorktreePath,
  worktreeListLinesToFields,
} from "./GitVcsDriverCore.ts";
import { makeSuccessfulHandle } from "./testing/configLockRegression.ts";
import { layerServerConfig } from "./testing/gitFixture.ts";

describe("existing worktree branches", () => {
  // Paths from the mini host, where a retried launch hit branch_already_exists.
  const gitForm = "C:/Users/super/.goat/worktrees/goat/fix-issues-557-588-windows-fixtures";
  const nodeForm =
    "C:\\Users\\Super\\.goat\\worktrees\\goat\\fix-issues-557-588-windows-fixtures\\";

  it("matches a Windows worktree across slash, case and trailing separator", () => {
    assert.isTrue(isSameWorktreePath(gitForm, nodeForm, "win32"));
    assert.isFalse(isSameWorktreePath(gitForm, `${nodeForm}-2`, "win32"));
    assert.isFalse(isSameWorktreePath("/Users/a/wt", "/users/a/wt", "darwin"));
    assert.isTrue(isSameWorktreePath("/Users/a/wt/", "/Users/a/wt", "linux"));
  });

  it("names the existing_worktree launch with a pasteable Windows path", () => {
    const detail = existingBranchConflictDetail({
      branch: "fix/issues-557-588-windows-fixtures",
      problem: "has 1 commit that f045007ed does not",
      worktreePath: nodeForm,
      suggestedPath: nodeForm,
    });
    assert.include(detail, "Branch fix/issues-557-588-windows-fixtures already exists");
    assert.deepStrictEqual(JSON.parse(/\{.*\}/u.exec(detail)![0]), {
      type: "existing_worktree",
      worktreePath: nodeForm,
      branch: "fix/issues-557-588-windows-fixtures",
    });
    assert.include(
      existingBranchConflictDetail({
        branch: "fix/x",
        problem: "has 2 commits that main does not",
        worktreePath: null,
        suggestedPath: "C:\\wt\\fix-x",
      }),
      'run git worktree add "C:\\wt\\fix-x" fix/x',
    );
  });
});

describe("worktreeListLinesToFields", () => {
  it("drops CR and unquotes C-quoted paths from the line form", () => {
    const lines =
      "worktree C:/repo\r\nHEAD abc\r\nbranch refs/heads/main\r\n\r\n" +
      'worktree "/tmp/caf\\303\\251 \\"q\\"\\ttab"\nbranch refs/heads/x\n\n';
    assert.deepEqual(worktreeListLinesToFields(lines).split("\0"), [
      "worktree C:/repo",
      "HEAD abc",
      "branch refs/heads/main",
      "",
      'worktree /tmp/café "q"\ttab',
      "branch refs/heads/x",
      "",
      "",
    ]);
  });
});

describe("Git output collection", () => {
  // Git writes in arbitrary chunk sizes; one byte per chunk splits every
  // multibyte character across reads.
  const byteChunks = (text: string) =>
    Stream.fromIterable(Array.from(new TextEncoder().encode(text), (byte) => Uint8Array.of(byte)));
  const makeDriver = (output: { stdout?: string; stderr?: string }) =>
    makeGitVcsDriverCore().pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.succeed(
            ChildProcessSpawner.makeHandle({
              ...makeSuccessfulHandle(""),
              stdout: byteChunks(output.stdout ?? ""),
              stderr: byteChunks(output.stderr ?? ""),
            }),
          ),
        ),
      ),
    );

  it.effect("returns the same split UTF-8 and NUL output with and without line callbacks", () =>
    Effect.gen(function* () {
      const stdout = "a\\b\0雪\nlast ";
      const stderr = "Receiving é\r\nUpdating 雪\rdone";
      const driver = yield* makeDriver({ stdout, stderr });
      const input = { operation: "test.chunkedGitOutput", cwd: "/repo", args: ["status"] };
      const expected = {
        exitCode: 0,
        stdout,
        stderr,
        stdoutTruncated: false,
        stderrTruncated: false,
      };

      assert.deepEqual(yield* driver.execute(input), expected);

      const stdoutLines: string[] = [];
      const stderrLines: string[] = [];
      const withCallbacks = yield* driver.execute({
        ...input,
        progress: {
          onStdoutLine: (line) => Effect.sync(() => void stdoutLines.push(line)),
          onStderrLine: (line) => Effect.sync(() => void stderrLines.push(line)),
        },
      });
      assert.deepEqual(withCallbacks, expected);
      assert.deepEqual(stdoutLines, ["a\\b\0雪", "last "]);
      assert.deepEqual(stderrLines, ["Receiving é", "Updating 雪", "done"]);
    }).pipe(
      Effect.provide(
        layerServerConfig.pipe(
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
  );

  it.effect("caps output without line callbacks", () =>
    Effect.gen(function* () {
      const driver = yield* makeDriver({ stderr: "é雪\rdone" });
      const input = {
        operation: "test.cappedGitOutput",
        cwd: "/repo",
        args: ["status"],
        maxOutputBytes: 3,
      };

      const truncated = yield* driver.execute({ ...input, appendTruncationMarker: true });
      assert.equal(truncated.stderr, "é\uFFFD");
      assert.isTrue(truncated.stderrTruncated);

      const error = yield* driver.execute(input).pipe(Effect.flip);
      assert.equal(error.outputLength, 4);
      assert.include(error.detail, "exceeded 3 bytes");
    }).pipe(
      Effect.provide(
        layerServerConfig.pipe(
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
  );
});
