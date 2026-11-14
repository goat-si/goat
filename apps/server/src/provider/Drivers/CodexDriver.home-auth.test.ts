// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { CodexDriver } from "./CodexDriver.ts";
import { layerTest } from "./CodexDriver.testkit.ts";

it.layer(layerTest)("Codex home auth", (it) => {
  it.effect(
    "regression #3079: inherited home changes invalidate auth while instance homes stay pinned",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        const homeA = NodePath.join(root, "authenticated");
        const homeB = NodePath.join(root, "signed-out");
        const binary = NodePath.join(root, "codex");
        yield* fs.writeFileString(binary, "fixture");
        yield* fs.chmod(binary, 0o755);
        const host: NodeJS.ProcessEnv = { PATH: "", CODEX_HOME: homeA };
        const homeBStarted = yield* Deferred.make<void>();
        const releaseHomeB = yield* Deferred.make<void>();
        let homeBChecks = 0;
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            const home = ChildProcess.isStandardCommand(command)
              ? command.options.env?.CODEX_HOME
              : undefined;
            const output = yield* Queue.unbounded<Uint8Array>();
            yield* Effect.addFinalizer(() => Queue.shutdown(output));
            return ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(4242),
              exitCode: Effect.never,
              isRunning: Effect.succeed(true),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.forEach((chunk: Uint8Array) =>
                Effect.gen(function* () {
                  for (const line of new TextDecoder().decode(chunk).trim().split("\n")) {
                    const request = JSON.parse(line) as { id?: number; method: string };
                    if (request.id === undefined) continue;
                    if (request.method === "account/read" && home === homeB) {
                      homeBChecks++;
                      yield* Deferred.succeed(homeBStarted, undefined);
                      yield* Deferred.await(releaseHomeB);
                    }
                    const result =
                      request.method === "initialize"
                        ? {
                            userAgent: "codex/0.164.0",
                            codexHome: home,
                            platformFamily: "unix",
                            platformOs: "macos",
                          }
                        : request.method === "config/read"
                          ? { config: {}, origins: {} }
                          : request.method === "account/read"
                            ? {
                                account: home === homeA ? { type: "apiKey" } : null,
                                requiresOpenaiAuth: true,
                              }
                            : request.method === "skills/list"
                              ? { data: [] }
                              : request.method === "account/rateLimits/read"
                                ? { rateLimits: {} }
                                : { data: [], nextCursor: null };
                    yield* Queue.offer(
                      output,
                      new TextEncoder().encode(JSON.stringify({ id: request.id, result }) + "\n"),
                    );
                  }
                }),
              ),
              stdout: Stream.fromQueue(output),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            });
          }),
        );
        const create = (pinned: boolean) =>
          CodexDriver.create({
            instanceId: ProviderInstanceId.make(pinned ? "pinned" : "inherited"),
            displayName: "Codex test",
            enabled: true,
            environment: [],
            config: {
              ...CodexDriver.defaultConfig(),
              binaryPath: binary,
              ...(pinned ? { homePath: homeA } : {}),
            },
          }).pipe(
            Effect.provideService(HostProcess.Environment, host),
            Effect.provideService(HostProcess.HomeDirectory, root),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          );
        const inherited = yield* create(false);
        const pinned = yield* create(true);
        expect((yield* inherited.snapshot.refresh).auth.status).toBe("authenticated");
        expect((yield* pinned.snapshot.refresh).auth.status).toBe("authenticated");
        host.CODEX_HOME = homeB;
        expect((yield* pinned.snapshot.getSnapshot).auth.status).toBe("authenticated");
        expect((yield* inherited.snapshot.getSnapshot).auth.status).not.toBe("authenticated");
        yield* Deferred.await(homeBStarted);
        expect((yield* inherited.snapshot.getSnapshot).auth.status).toBe("unknown");
        expect((yield* inherited.snapshot.getSnapshot).auth.status).toBe("unknown");
        expect(homeBChecks).toBe(1);
        yield* Deferred.succeed(releaseHomeB, undefined);
        expect((yield* inherited.snapshot.refresh).auth.status).toBe("unauthenticated");
      }).pipe(Effect.scoped),
  );
});
