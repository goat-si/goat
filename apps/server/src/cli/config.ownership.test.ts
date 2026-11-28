// @effect-diagnostics nodeBuiltinImport:off - Tests exercise native Node fixture boundaries.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, expect, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as NetService from "@goat/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodePath from "node:path";
import * as ProcessRunner from "../processRunner.ts";
import { acquireServerOwnership } from "../serverOwnership.ts";
import { resolveServerConfig } from "./config.ts";

const encodeUnknownJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const liveProcess = Effect.acquireRelease(
  Effect.promise(async () => {
    const child = NodeChildProcess.spawn(process.execPath, ["-e", "process.stdin.resume()"], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    await NodeEvents.EventEmitter.once(child, "spawn");
    return child;
  }),
  (child) =>
    Effect.promise(async () => {
      const exited = NodeEvents.EventEmitter.once(child, "exit");
      child.kill();
      await exited;
    }),
);

it.layer(NodeServices.layer)("CLI ownership preflight", (it) => {
  const minimalWebFlags = (baseDir: string) => ({
    mode: Option.some("web" as const),
    port: Option.some(3773),
    host: Option.none<string>(),
    baseDir: Option.some(baseDir),
    cwd: Option.none<string>(),
    devUrl: Option.none<URL>(),
    noBrowser: Option.none<boolean>(),
    bootstrapFd: Option.none<number>(),
    autoBootstrapProjectFromCwd: Option.none<boolean>(),
    logWebSocketEvents: Option.none<boolean>(),
    tailscaleServeEnabled: Option.none<boolean>(),
    tailscaleServePort: Option.none<number>(),
  });

  const acquireOwnership = (baseDir: string) =>
    acquireServerOwnership(NodePath.join(baseDir, "userdata", "server-runtime.json")).pipe(
      Effect.provide(Layer.merge(ProcessRunner.layer, NodeCrypto.layer)),
      Effect.provideService(HostProcess.HomeDirectory, baseDir),
      Effect.provideService(HostProcess.Environment, {}),
    );

  const resolveManualWebLaunch = (baseDir: string, cwd: string) =>
    resolveServerConfig({ ...minimalWebFlags(baseDir), cwd: Option.some(cwd) }, Option.none(), {
      rejectRunningServer: true,
    }).pipe(
      Effect.provide(
        Layer.merge(NetService.layer, ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
      ),
      Effect.mapError(String),
      Effect.result,
    );

  it.effect("refuses a manual web launch while a lock-aware server owns the GOAT home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-cli-preflight-live-" });
      const child = yield* liveProcess;
      assert(child.pid !== undefined);
      const owner = yield* acquireOwnership(baseDir);
      yield* owner.publish({
        version: 1,
        pid: child.pid,
        port: 3773,
        origin: "http://127.0.0.1:3773",
        startedAt: "2026-10-01T00:00:00.000Z",
      });
      const cwd = path.join(baseDir, "project");
      const result = yield* resolveManualWebLaunch(baseDir, cwd);
      assert(Result.isFailure(result));
      expect(result.failure).toContain("A GOAT server is already running");
      expect(result.failure).toContain(`pid ${child.pid}`);
      expect(yield* fs.exists(cwd)).toBe(false);
    }),
  );

  it.effect("refuses a manual web launch when a pre-lock record belongs to a live process", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-cli-preflight-legacy-" });
      const child = yield* liveProcess;
      assert(child.pid !== undefined);
      const stateDir = path.join(baseDir, "userdata");
      yield* fs.makeDirectory(stateDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(stateDir, "server-runtime.json"),
        yield* encodeUnknownJson({
          version: 1,
          pid: child.pid,
          port: 3773,
          origin: "http://127.0.0.1:3773",
          startedAt: "2026-10-01T00:00:00.000Z",
        }),
      );
      const cwd = path.join(baseDir, "project");
      const result = yield* resolveManualWebLaunch(baseDir, cwd);
      assert(Result.isFailure(result));
      expect(result.failure).toContain(`pid ${child.pid}`);
      expect(yield* fs.exists(cwd)).toBe(false);
    }),
  );

  it.effect(
    "allows a manual web launch when a lock-aware record's PID was reused by an unrelated process",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-cli-preflight-live-" });
        const child = yield* liveProcess;
        assert(child.pid !== undefined);
        // The killed server's lock file stays behind, released.
        yield* Effect.scoped(acquireOwnership(baseDir));
        yield* fs.writeFileString(
          path.join(baseDir, "userdata", "server-runtime.json"),
          yield* encodeUnknownJson({
            version: 1,
            pid: child.pid,
            ownerId: "4ec9f94a-0000-4000-8000-000000000000",
            port: 3773,
            origin: "http://127.0.0.1:3773",
            startedAt: "2026-10-01T00:00:00.000Z",
          }),
        );
        const cwd = path.join(baseDir, "project");
        const result = yield* resolveManualWebLaunch(baseDir, cwd);
        expect(result).toEqual(Result.succeed(expect.objectContaining({ cwd })));
      }),
  );
});
