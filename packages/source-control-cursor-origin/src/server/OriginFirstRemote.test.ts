import { assert, it } from "@effect/vitest";
import { GitCommandError } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SourceControlHost from "@goat/source-control-core/server/SourceControlHost";
import { ChildProcessSpawner } from "effect/process";
import * as OriginCli from "./OriginCli.ts";

it.effect.each(["multiple", "single", "missing", "failed"] as const)(
  "handles %s Cursor Origin fetch URLs",
  (mode) =>
    Effect.gen(function* () {
      const cli = yield* OriginCli.OriginCli;
      if (mode === "missing" || mode === "failed") {
        const error = yield* Effect.flip(cli.resolveRepository({ cwd: "/repo" }));
        assert.strictEqual(error._tag, "OriginCliError");
        assert.strictEqual(error.reason, "not-found");
        return;
      }
      assert.strictEqual(yield* cli.resolveRepository({ cwd: "/repo" }), "team/first");
    }).pipe(
      Effect.provide(
        OriginCli.layer.pipe(
          Layer.provide(
            Layer.mock(SourceControlHost.SourceControlHost)({
              git: {
                resolvePrimaryRemoteName: () => Effect.succeed("origin"),
                readConfigValue: () => Effect.succeed("git@origin.cursor.com:team/last.git"),
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
                    : Effect.succeed({
                        exitCode: ChildProcessSpawner.ExitCode(0),
                        stdout:
                          mode === "missing"
                            ? ""
                            : `git@origin.cursor.com:team/first.git\n${mode === "multiple" ? "git@origin.cursor.com:team/last.git\n" : ""}`,
                        stderr: "",
                        stdoutTruncated: false,
                        stderrTruncated: false,
                      }),
              },
            } as never),
          ),
        ),
      ),
    ),
);
