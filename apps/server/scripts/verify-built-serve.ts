#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as NetService from "@goat/shared/Net";

export class BuiltServeError extends Schema.TaggedError<BuiltServeError>()("BuiltServeError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return `The built server did not serve: ${this.detail}`;
  }
}

const collect = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

/**
 * goat-ci runs the server from source, while the CLI archive and desktop app run this bundle, so
 * a dependency that reads its own files at runtime fails only here. Serves it the way
 * scripts/smoke-cli-archive.ts serves the packaged CLI.
 */
const verifyBuiltServe = Effect.fn("verifyBuiltServe")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const distDir = path.join(import.meta.dirname, "../dist");
  if (!(yield* fs.exists(path.join(distDir, "client/index.html")))) {
    return yield* new BuiltServeError({
      detail: `no build with a web client at ${distDir}; run vp run build:desktop first`,
    });
  }
  const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "goat-built-serve-" });
  const port = yield* (yield* NetService.NetService).findAvailablePort(47800);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const server = yield* spawner.spawn(
    ChildProcess.make(
      process.execPath,
      [
        path.join(distDir, "bin.mjs"),
        "serve",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--no-browser",
      ],
      {
        cwd: scratch,
        env: {
          PATH: "",
          HOME: scratch,
          USERPROFILE: scratch,
          TMPDIR: scratch,
          TEMP: scratch,
          GOAT_HOME: scratch,
          GOAT_TELEMETRY_ENABLED: "false",
        },
        extendEnv: false,
      },
    ),
  );
  const output = yield* Effect.forkScoped(
    Effect.all([collect(server.stdout), collect(server.stderr)], { concurrency: "unbounded" }),
  );
  const httpClient = yield* HttpClient.HttpClient;
  const probe = httpClient.execute(HttpClientRequest.get(`http://127.0.0.1:${String(port)}/`)).pipe(
    Effect.map((response) => response.status === 200),
    Effect.timeout(Duration.seconds(2)),
    Effect.orElseSucceed(() => false),
  );
  const pollUntilReady = Effect.gen(function* () {
    while (!(yield* probe)) {
      yield* Effect.sleep(Duration.millis(250));
    }
    return true;
  });
  // A crash at startup fails at once instead of waiting out the timeout.
  const ready = yield* Effect.raceFirst(
    pollUntilReady.pipe(Effect.timeout(Duration.seconds(30))),
    server.exitCode.pipe(Effect.as(false)),
  ).pipe(Effect.orElseSucceed(() => false));
  yield* server.kill({ killSignal: "SIGTERM" }).pipe(Effect.ignore);
  yield* server.exitCode.pipe(Effect.timeout(Duration.seconds(10)), Effect.ignore);
  if (ready) {
    yield* Effect.log(`[built-serve] The built server answered 200 on port ${String(port)}.`);
    return;
  }
  const [stdout, stderr] = yield* Fiber.join(output).pipe(
    Effect.timeout(Duration.seconds(5)),
    Effect.orElseSucceed(() => ["", ""] as const),
  );
  return yield* new BuiltServeError({
    detail: `it exited or gave no 200 from / within 30s\n${stdout}${stderr}`,
  });
});

if (import.meta.main) {
  verifyBuiltServe().pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        Logger.layer([Logger.consolePretty()]),
        NodeServices.layer,
        NetService.layer,
        FetchHttpClient.layer,
      ),
    ),
    NodeRuntime.runMain,
  );
}
