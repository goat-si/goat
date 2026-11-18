import * as HostProcess from "@goat/shared/HostProcess";
import * as NodeServices from "@goat/shared/testing/nodeServicesWithCrypto";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner, type CommandLine } from "effect/process";

import { prebuildAndroid } from "./lib/mobile-native-prebuild.ts";
import { installIntoSession, NativeClientError } from "./mobile-native-client.ts";

const caches = [".gradle/history", "app/.cxx/object"];

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const mobile = yield* fs.makeTempDirectoryScoped({ prefix: "mobile-native-client-" });
  const android = path.join(mobile, "android");
  for (const cache of caches) {
    yield* fs.makeDirectory(path.dirname(path.join(android, cache)), { recursive: true });
    yield* fs.writeFileString(path.join(android, cache), cache);
  }
  const cleanPrebuild = Effect.gen(function* () {
    yield* fs.remove(android, { recursive: true });
    yield* fs.makeDirectory(path.join(android, "app"), { recursive: true });
    yield* fs.writeFileString(path.join(android, "app/build.gradle"), "regenerated");
  });
  const assertCachesRestored = Effect.gen(function* () {
    for (const cache of caches) {
      assert.strictEqual(yield* fs.readFileString(path.join(android, cache)), cache);
    }
    assert.deepStrictEqual(yield* fs.readDirectory(mobile), ["android"]);
  });
  return { fs, path, mobile, android, cleanPrebuild, assertCachesRestored };
});

it.layer(NodeServices.layer)("prebuildAndroid", (it) => {
  it.effect("keeps Gradle and native caches through a clean prebuild", () =>
    Effect.gen(function* () {
      const { fs, path, mobile, android, cleanPrebuild, assertCachesRestored } = yield* fixture;

      yield* prebuildAndroid(mobile, cleanPrebuild);

      assert.strictEqual(
        yield* fs.readFileString(path.join(android, "app/build.gradle")),
        "regenerated",
      );
      yield* assertCachesRestored;
    }),
  );

  it.effect("restores the caches and returns the error when prebuild fails", () =>
    Effect.gen(function* () {
      const { mobile, cleanPrebuild, assertCachesRestored } = yield* fixture;
      const failure = new NativeClientError({ message: "prebuild failed" });

      const error = yield* prebuildAndroid(
        mobile,
        cleanPrebuild.pipe(Effect.andThen(Effect.fail(failure))),
      ).pipe(Effect.flip);

      assert.strictEqual(error, failure);
      yield* assertCachesRestored;
    }),
  );
});

it.effect("opens GOAT Dev against Metro with the same pooled target used to install", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-native-client-session-" });
    const fingerprint = "a".repeat(40);
    const cache = path.join(
      home,
      ".cache/goat/native-clients/artifacts/ios/development",
      fingerprint,
    );
    yield* fs.makeDirectory(cache, { recursive: true });
    const artifact = path.join(cache, "GOATDev.app");
    yield* fs.writeFileString(artifact, "synthetic artifact");
    const commands: ReadonlyArray<CommandLine.Word>[] = [];
    const spawner = ChildProcessSpawner.make((child) => {
      if (child._tag !== "StandardCommand") return Effect.die("Expected a single command");
      const isFingerprint = child.args[0] === "--eval";
      if (!isFingerprint) commands.push(child.args.slice(1));
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: isFingerprint
            ? Stream.make(new TextEncoder().encode(`GOAT_NATIVE_FINGERPRINT=${fingerprint}`))
            : Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    });
    const config = path.join(home, "gateway.json");
    yield* installIntoSession(
      home,
      "ios",
      "lease-9",
      "x86_64",
      "http://metro.test:8081",
      config,
    ).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(HostProcess.Environment, { GOAT_NATIVE_CLIENT_CACHE: "off" }),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Unexpected HTTP request")),
      ),
    );
    assert.deepStrictEqual(commands, [
      ["install", "si.goat.mobile.dev", artifact, "--session", "lease-9", "--config", config],
      [
        "open",
        "si.goat.mobile.dev",
        "goat-dev://expo-development-client/?url=http%3A%2F%2Fmetro.test%3A8081&disableOnboarding=1&disableFab=1&disableAutoLaunch=1",
        "--session",
        "lease-9",
        "--config",
        config,
      ],
    ]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
