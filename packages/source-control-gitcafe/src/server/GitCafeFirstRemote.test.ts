import { assert, it } from "@effect/vitest";
import { GitCommandError } from "@goat/contracts";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { processOutput } from "@goat/source-control-testing/TestSourceControlHost";
import * as TestSourceControlHost from "@goat/source-control-testing/TestSourceControlHost";
import * as GitCafeApi from "./GitCafeApi.ts";
import * as Provider from "./GitCafeSourceControlProvider.ts";

it.effect.each(["multiple", "single", "missing", "failed"] as const)(
  "handles %s GitCafe fetch URLs",
  (mode) => {
    const paths: string[] = [];
    return Effect.gen(function* () {
      const provider = yield* Provider.make;
      if (mode === "missing" || mode === "failed") {
        const error = yield* Effect.flip(provider.getDefaultBranch({ cwd: "/repo" }));
        assert.strictEqual(error._tag, "SourceControlProviderError");
        assert.deepStrictEqual(paths, []);
        return;
      }
      assert.strictEqual(yield* provider.getDefaultBranch({ cwd: "/repo" }), "main");
      assert.deepStrictEqual(paths, ["/repos/team/first"]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          FileSystem.layerNoop({}),
          TestSourceControlHost.layer({
            git: {
              resolvePrimaryRemoteName: () => Effect.succeed("origin"),
              readConfigValue: () => Effect.succeed("git@git.cafe:team/last.git"),
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
                          : `git@git.cafe:team/first.git\n${mode === "multiple" ? "git@git.cafe:team/last.git\n" : ""}`,
                      ),
                    ),
            },
          }),
          Layer.mock(GitCafeApi.GitCafeApi)({
            request: (input) =>
              Effect.sync(() => {
                paths.push(input.path);
                return JSON.stringify({ name: "first", defaultBranch: "main" });
              }),
          }),
        ),
      ),
    );
  },
);
