import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HostProcess from "@goat/shared/HostProcess";
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

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.effect.each([
  { name: "transport failure", stderr: "error sending request for url", status: "unknown" },
  { name: "rejected token", stderr: "invalid credentials", status: "unauthenticated" },
] as const)("distinguishes $name for an fj login", ({ stderr, status }) =>
  Effect.gen(function* () {
    const spec = yield* ForgejoSourceControlProvider.makeDiscovery.pipe(
      Effect.provide(ForgejoCli.layer),
    );
    assert.strictEqual(spec.type, "managed-cli");
    if (spec.type !== "managed-cli") return;
    const result = yield* spec.probe("/repo");
    assert.strictEqual(result.executable, "fj");
    assert.strictEqual(result.auth.status, status);
  }).pipe(
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        exists: () => Effect.succeed(true),
        // fj stores the host without the scheme the login used.
        readFileString: () =>
          Effect.succeed(
            encodeJson({
              hosts: { "forgejo.local:3000": { type: "Application", token: "test-token" } },
            }),
          ),
      }),
    ),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        request.url.startsWith("http://")
          ? Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(encodeJson({ login: "maria" }), { status: 200 }),
              ),
            )
          : Effect.die(new Error("received corrupt message of type InvalidContentType")),
      ),
    ),
    Effect.provide(
      TestSourceControlHost.layer({
        process: {
          run: (input) => {
            // Settings has no project in scope, so there is no origin remote.
            if (input.command === "git")
              return Effect.succeed(
                processOutput("", { exitCode: ChildProcessSpawner.ExitCode(2) }),
              );
            if (input.command !== "fj")
              return Effect.fail(
                new VcsProcessSpawnError({
                  operation: input.operation,
                  command: input.command,
                  cwd: input.cwd,
                  cause: new Error("not installed"),
                }),
              );
            if (input.args[0] === "version") return Effect.succeed(processOutput("fj v0.7.0"));
            const host = input.args[input.args.indexOf("--host") + 1] ?? "";
            return Effect.succeed(
              host.startsWith("http://")
                ? processOutput("currently signed into maria@forgejo.local:3000")
                : processOutput("", {
                    exitCode: ChildProcessSpawner.ExitCode(1),
                    stderr,
                  }),
            );
          },
        },
      }),
    ),
    Effect.provideService(HostProcess.HomeDirectory, "/home/maria"),
  ),
);
