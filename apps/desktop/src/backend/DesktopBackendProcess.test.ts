import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as DesktopBackendProcess from "./DesktopBackendProcess.ts";

const http = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }))),
  ),
);

const childShutdown = (exitOnTerm: boolean) =>
  Effect.scoped(
    Effect.gen(function* () {
      const scope = yield* Effect.acquireRelease(Scope.make("sequential"), (scope) =>
        Scope.close(scope, Exit.void),
      );
      const ready = yield* Deferred.make<void>();
      const chunks: string[] = [];
      const script = `process.on('SIGTERM', () => { console.log('shutdown line'); ${exitOnTerm ? "process.exit(0)" : ""} }); console.log('ready'); setInterval(() => {}, 1000)`;
      const run = yield* DesktopBackendProcess.runBackendProcess({
        executablePath: process.execPath,
        entryPath: "fixture",
        args: ["-e", script],
        cwd: process.cwd(),
        env: {},
        extendEnv: true,
        bootstrap: {
          mode: "desktop",
          noBrowser: true,
          port: 3773,
          goatHome: "/tmp/t3",
          host: "127.0.0.1",
          desktopBootstrapToken: "token",
          tailscaleServeEnabled: false,
          tailscaleServePort: 443,
        },
        bootstrapDelivery: "stdin",
        httpBaseUrl: new URL("http://127.0.0.1:3773"),
        captureOutput: true,
        preflightFailure: Option.none(),
        desktopTelemetryStream: Stream.empty,
        terminateGrace: Duration.millis(200),
        onOutput: (_stream, chunk) =>
          Effect.gen(function* () {
            const text = new TextDecoder().decode(chunk);
            chunks.push(text);
            if (text.includes("ready")) yield* Deferred.succeed(ready, undefined);
          }),
      }).pipe(Scope.provide(scope), Effect.forkChild);
      yield* Deferred.await(ready);
      yield* Scope.close(scope, Exit.void);
      const exit = yield* Fiber.join(run);
      assert.equal(exit.reason, exitOnTerm ? "code=0" : "killed by SIGKILL");
      assert.include(chunks.join(""), "shutdown line");
    }).pipe(Effect.provide(Layer.merge(NodeServices.layer, http))),
  );

it.live("retains SIGTERM output from a child that needs SIGKILL", () => childShutdown(false));
it.live("retains SIGTERM output from a child that exits cleanly", () => childShutdown(true));
