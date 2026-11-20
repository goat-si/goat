import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, describe } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { ChildProcessSpawner } from "effect/process";
import { makeFailedHandle } from "./testing/configLockRegression.ts";
import { layerServerConfig } from "./testing/gitFixture.ts";

describe("rejected git refs", () => {
  const remoteUrl = "https://user:token-123@git.example.invalid/org/secret-repo.git";
  const failedPush = `error: failed to push some refs to '${remoteUrl}'`;
  const leakedText = [
    "token-123",
    "secret-repo",
    "git.example.invalid",
    "private-branch",
    "workflow scope",
  ];

  const failWith = (stderr: string) => {
    const spawner = ChildProcessSpawner.make(() => Effect.succeed(makeFailedHandle(stderr)));
    const layer = GitVcsDriver.layer.pipe(
      Layer.provide(layerServerConfig),
      Layer.provideMerge(
        Layer.merge(
          Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      ),
    );
    return Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      return yield* driver
        .execute({
          operation: "GitVcsDriver.test.rejectedRef",
          cwd: "/repo",
          args: ["push", "origin", "HEAD"],
        })
        .pipe(Effect.flip);
    }).pipe(Effect.provide(layer));
  };

  it.effect.each([
    {
      label: "a ref the remote refused",
      stderr: [
        "remote: Unable to determine if workflow can be created; workflow scope may be required.",
        `To ${remoteUrl}`,
        " ! [remote rejected] private-branch -> private-branch (workflow scope may be required.)",
        failedPush,
      ],
      reason: "push_rejected_by_remote" as const,
      detail: "The remote rejected the push.",
    },
    {
      label: "a non-fast-forward push",
      stderr: [
        `To ${remoteUrl}`,
        " ! [rejected]        private-branch -> private-branch (non-fast-forward)",
        failedPush,
      ],
      reason: "push_rejected_non_fast_forward" as const,
      detail: "Pull or rebase",
    },
  ])("names $label without quoting stderr", ({ stderr, reason, detail }) =>
    Effect.gen(function* () {
      const error = yield* failWith(stderr.join("\n"));

      assert.deepInclude(error, { reason });
      assert.include(error.detail, detail);
      for (const text of leakedText) assert.notInclude(error.message, text);
    }),
  );

  // A fetch into a diverged local branch prints the same rejected line, but
  // never "failed to push some refs".
  it.effect("leaves a rejected fetch unclassified", () =>
    Effect.gen(function* () {
      const error = yield* failWith(
        [`From ${remoteUrl}`, " ! [rejected]        main       -> side  (non-fast-forward)"].join(
          "\n",
        ),
      );

      assert.equal(error.reason, undefined);
      assert.equal(error.detail, "Git command exited with a non-zero status.");
    }),
  );
});
