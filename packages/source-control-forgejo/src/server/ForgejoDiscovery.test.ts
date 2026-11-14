import { assert, it } from "@effect/vitest";
import { VcsProcessSpawnError, VcsProcessTimeoutError } from "@goat/contracts";
import * as TestSourceControlHost from "@goat/source-control-testing/TestSourceControlHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as ForgejoCli from "./ForgejoCli.ts";
import * as ForgejoSourceControlProvider from "./ForgejoSourceControlProvider.ts";
const processOutput = TestSourceControlHost.processOutput;

it.effect("explains a slow fj instead of advising an install when tea is absent", () =>
  Effect.gen(function* () {
    const spec = yield* ForgejoSourceControlProvider.makeDiscovery;
    assert.strictEqual(spec.type, "managed-cli");
    if (spec.type !== "managed-cli") return;
    const result = yield* spec.probe("/repo");
    assert.strictEqual(result.status, "missing");
    assert.strictEqual(result.executable, "fj");
    assert.include(result.installHint, "`fj version` timed out");
    assert.notInclude(result.installHint, "Install");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ForgejoCli.ForgejoCli)({ listLogins: () => Effect.succeed([]) }),
        TestSourceControlHost.layer({
          process: {
            run: (input) => {
              const context = {
                operation: input.operation,
                command: input.command,
                cwd: input.cwd,
              };
              if (input.command === "git") return Effect.succeed(processOutput(""));
              if (input.command === "fj")
                return Effect.fail(new VcsProcessTimeoutError({ ...context, timeoutMs: 5_000 }));
              return Effect.fail(
                new VcsProcessSpawnError({
                  ...context,
                  cause: PlatformError.systemError({
                    _tag: "NotFound",
                    module: "ChildProcess",
                    method: "spawn",
                    pathOrDescriptor: input.command,
                  }),
                }),
              );
            },
          },
        }),
      ),
    ),
  ),
);
