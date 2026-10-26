// @effect-diagnostics nodeBuiltinImport:off - builds real worktree layouts on disk.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NetService from "@goat/shared/Net";
import * as HostProcess from "@goat/shared/HostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as ByteSize from "effect/ByteSize";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import {
  checkPortAvailabilityOnHosts,
  createDevRunnerEnv,
  findFirstAvailableOffset,
  resolveModePortOffsets,
  runDevRunnerWithInput,
} from "./dev-runner.ts";

const emptyConfigLayer = ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }));
const isWindows = HostProcess.Platform.defaultValue() === "win32";

const netServiceLayer = Layer.succeed(NetService.NetService, {
  canListenOnHost: () => Effect.succeed(true),
  isPortAvailableOnLoopback: () => Effect.succeed(true),
  hasListenerOnHost: () => Effect.succeed(false),
  reserveLoopbackPort: () => Effect.succeed(49_152),
  findAvailablePort: (port) => Effect.succeed(port),
});

function mockProcess(exit: number | PlatformError.PlatformError) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode:
      typeof exit === "number"
        ? Effect.succeed(ChildProcessSpawner.ExitCode(exit))
        : Effect.fail(exit),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

const devServerInput = {
  mode: "dev:server",
  goatHome: "/tmp/t3code-dev-runner",
  browser: undefined,
  autoBootstrapProjectFromCwd: undefined,
  logWebSocketEvents: undefined,
  host: undefined,
  port: 13_773,
  devUrl: undefined,
  dryRun: false,
  share: false,
  built: false,
  runArgs: ["--inspect", "secret-token-value"],
} as const;

it.layer(NodeServices.layer)("dev-runner", (it) => {
  describe("createDevRunnerEnv", () => {
    it.effect("forwards the reusable auth token to web dev and removes it for desktop", () =>
      Effect.gen(function* () {
        const input = {
          baseEnv: { GOAT_DEV_AUTH_TOKEN: "reusable-dev-auth-token-that-is-long-enough" },
          serverOffset: 0,
          webOffset: 0,
          goatHome: undefined,
          browser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        } as const;
        const web = yield* createDevRunnerEnv({ ...input, mode: "dev" });
        const desktop = yield* createDevRunnerEnv({ ...input, mode: "dev:desktop" });

        assert.equal(web.GOAT_DEV_AUTH_TOKEN, input.baseEnv.GOAT_DEV_AUTH_TOKEN);
        assert.equal(desktop.GOAT_DEV_AUTH_TOKEN, undefined);
      }),
    );

    it.effect("lets web dev accept every cookie a browser keeps for localhost (#1185)", () =>
      Effect.gen(function* () {
        const input = {
          baseEnv: { NODE_OPTIONS: "--enable-source-maps --max-http-header-size=8192" },
          serverOffset: 0,
          webOffset: 0,
          goatHome: undefined,
          browser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        } as const;
        const web = yield* createDevRunnerEnv({ ...input, mode: "dev" });
        const desktop = yield* createDevRunnerEnv({ ...input, mode: "dev:desktop" });

        assert.equal(web.NODE_OPTIONS, "--enable-source-maps --max-http-header-size=262144");
        assert.equal(desktop.NODE_OPTIONS, input.baseEnv.NODE_OPTIONS);
      }),
    );

    it.effect("turns product analytics off unless the developer opts in", () =>
      Effect.gen(function* () {
        const input = {
          mode: "dev",
          serverOffset: 0,
          webOffset: 0,
          goatHome: undefined,
          browser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        } as const;
        const byDefault = yield* createDevRunnerEnv({ ...input, baseEnv: {} });
        const optedIn = yield* createDevRunnerEnv({
          ...input,
          baseEnv: { GOAT_TELEMETRY_ENABLED: "true" },
        });

        assert.equal(byDefault.GOAT_TELEMETRY_ENABLED, "false");
        assert.equal(optedIn.GOAT_TELEMETRY_ENABLED, "true");
      }),
    );

    it.effect("strips inherited service-launcher context", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev",
          baseEnv: {
            GOAT_SERVICE_LAUNCHER_CONTEXT: '{"childVersion":"9.9.9"}',
            GOAT_BOOT_SERVICE_UNIT: "goat.service",
          },
          serverOffset: 0,
          webOffset: 0,
          goatHome: undefined,
          browser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.GOAT_SERVICE_LAUNCHER_CONTEXT, undefined);
        assert.equal(env.GOAT_BOOT_SERVICE_UNIT, undefined);
      }),
    );

    it.effect.each(["dev", "dev:web"] as const)(
      "leaves the client backend URLs unset in %s mode",
      (mode) =>
        Effect.gen(function* () {
          const env = yield* createDevRunnerEnv({
            mode,
            baseEnv: {
              VITE_HTTP_URL: "http://localhost:1234",
              VITE_WS_URL: "ws://localhost:1234",
            },
            serverOffset: 0,
            webOffset: 0,
            goatHome: undefined,
            browser: undefined,
            autoBootstrapProjectFromCwd: undefined,
            logWebSocketEvents: undefined,
            host: undefined,
            port: undefined,
            devUrl: undefined,
          });

          assert.equal(env.VITE_HTTP_URL, undefined);
          assert.equal(env.VITE_WS_URL, undefined);
          assert.equal(env.GOAT_PORT, "13773");
          assert.equal(env.GOAT_SINGLE_ORIGIN_DEV, "1");
        }),
    );

    it.effect.each(["dev", "dev:web"] as const)("drops an inherited HOST in %s mode", (mode) =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode,
          baseEnv: { HOST: "0.0.0.0" },
          serverOffset: 0,
          webOffset: 0,
          goatHome: undefined,
          browser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.HOST, undefined);
      }),
    );
  });

  describe("findFirstAvailableOffset", () => {
    it.effect("advances until all required ports are available", () =>
      Effect.gen(function* () {
        const taken = new Set([13773, 5733, 13774, 5734]);
        const offset = yield* findFirstAvailableOffset({
          startOffset: 0,
          requireServerPort: true,
          requireWebPort: true,
          checkPortAvailability: (port) => Effect.succeed(!taken.has(port)),
        });

        assert.equal(offset, 2);
      }),
    );

    it.effect("skips browser-blocked web ports before probing availability", () =>
      Effect.gen(function* () {
        const probed: Array<{ port: number; role: string | undefined }> = [];
        const offset = yield* findFirstAvailableOffset({
          // 5733 + 833 = 6566, which browsers block as sane-port.
          startOffset: 833,
          requireServerPort: true,
          requireWebPort: true,
          checkPortAvailability: (port, role) => {
            probed.push({ port, role });
            return Effect.succeed(true);
          },
        });

        assert.equal(offset, 834);
        assert.deepStrictEqual(probed, [
          { port: 14_607, role: "server" },
          { port: 6567, role: "web" },
        ]);
      }),
    );

    it.effect("does not reject a server-only offset because its unused web port is blocked", () =>
      Effect.gen(function* () {
        const offset = yield* findFirstAvailableOffset({
          startOffset: 833,
          requireServerPort: true,
          requireWebPort: false,
          checkPortAvailability: () => Effect.succeed(true),
        });

        assert.equal(offset, 833);
      }),
    );
  });

  describe("checkPortAvailabilityOnHosts", () => {
    it.effect("checks overlapping hosts sequentially to avoid self-interference", () =>
      Effect.gen(function* () {
        let inFlightCount = 0;
        const calls: Array<[number, string]> = [];

        const available = yield* checkPortAvailabilityOnHosts(
          13_773,
          ["127.0.0.1", "0.0.0.0", "::"],
          (port, host) =>
            Effect.promise(async () => {
              calls.push([port, host]);
              inFlightCount += 1;
              const overlapped = inFlightCount > 1;
              await Promise.resolve();
              inFlightCount -= 1;
              return !overlapped;
            }),
        );

        assert.equal(available, true);
        assert.deepStrictEqual(calls, [
          [13_773, "127.0.0.1"],
          [13_773, "0.0.0.0"],
          [13_773, "::"],
        ]);
      }),
    );
  });

  describe("devPortProbeHosts", () => {
    it.effect("passes the port role so only the server port sees the bind host", () =>
      Effect.gen(function* () {
        const probed: Array<{ port: number; role: string | undefined }> = [];

        yield* resolveModePortOffsets({
          mode: "dev",
          startOffset: 0,
          hasExplicitServerPort: false,
          hasExplicitDevUrl: false,
          checkPortAvailability: (port, role) => {
            probed.push({ port, role });
            return Effect.succeed(true);
          },
        });

        assert.deepStrictEqual(probed, [
          { port: 13_773, role: "server" },
          { port: 5733, role: "web" },
        ]);
      }),
    );
  });

  describe("resolveModePortOffsets", () => {
    it.effect("uses a shared fallback offset for dev mode", () =>
      Effect.gen(function* () {
        const taken = new Set([13773, 5733]);
        const offsets = yield* resolveModePortOffsets({
          mode: "dev",
          startOffset: 0,
          hasExplicitServerPort: false,
          hasExplicitDevUrl: false,
          checkPortAvailability: (port) => Effect.succeed(!taken.has(port)),
        });

        assert.deepStrictEqual(offsets, { serverOffset: 1, webOffset: 1 });
      }),
    );

    it.effect("keeps server offset stable for dev:web and only shifts web offset", () =>
      Effect.gen(function* () {
        const taken = new Set([5733]);
        const offsets = yield* resolveModePortOffsets({
          mode: "dev:web",
          startOffset: 0,
          hasExplicitServerPort: false,
          hasExplicitDevUrl: false,
          checkPortAvailability: (port) => Effect.succeed(!taken.has(port)),
        });

        assert.deepStrictEqual(offsets, { serverOffset: 0, webOffset: 1 });
      }),
    );

    it.effect("shifts only server offset for dev:server", () =>
      Effect.gen(function* () {
        const taken = new Set([13773]);
        const offsets = yield* resolveModePortOffsets({
          mode: "dev:server",
          startOffset: 0,
          hasExplicitServerPort: false,
          hasExplicitDevUrl: false,
          checkPortAvailability: (port) => Effect.succeed(!taken.has(port)),
        });

        assert.deepStrictEqual(offsets, { serverOffset: 1, webOffset: 1 });
      }),
    );

    it.effect("respects explicit dev-url override for dev:web", () =>
      Effect.gen(function* () {
        const offsets = yield* resolveModePortOffsets({
          mode: "dev:web",
          startOffset: 0,
          hasExplicitServerPort: false,
          hasExplicitDevUrl: true,
          checkPortAvailability: () => Effect.succeed(false),
        });

        assert.deepStrictEqual(offsets, { serverOffset: 0, webOffset: 0 });
      }),
    );
  });

  describe("runDevRunnerWithInput", () => {
    it.effect("preserves process spawn context and the exact platform cause", () => {
      const cause = PlatformError.systemError({
        _tag: "NotFound",
        module: "ChildProcess",
        method: "spawn",
        description: "vp was not found",
      });
      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.fail(cause)),
      );

      return Effect.gen(function* () {
        const error = yield* runDevRunnerWithInput(devServerInput).pipe(
          Effect.provide(Layer.mergeAll(emptyConfigLayer, netServiceLayer, spawnerLayer)),
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.flip,
        );

        if (error._tag !== "DevRunnerProcessError") {
          assert.fail(`Unexpected error: ${error._tag}`);
        }
        assert.equal(error.operation, "spawn");
        assert.equal(error.mode, "dev:server");
        assert.equal(error.executable, "vp");
        assert.equal(error.argumentCount, 5);
        assert.equal(error.shell, false);
        assert.equal(error.cause, cause);
        assert.ok(!error.message.includes(cause.message));
        assert.notProperty(error, "args");
        assert.notInclude(error.message, "secret-token-value");
      });
    });

    it.effect("ignores an ambient GOAT_HOME when no home is resolved", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev",
          baseEnv: { GOAT_HOME: "/home/user/.t3" },
          serverOffset: 0,
          webOffset: 0,
          goatHome: undefined,
          browser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.GOAT_HOME, undefined);
      }),
    );

    it.effect("rejects a specific non-loopback --host for browser dev modes", () => {
      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.succeed(mockProcess(0))),
      );

      return Effect.gen(function* () {
        const error = yield* runDevRunnerWithInput({
          ...devServerInput,
          mode: "dev",
          port: undefined,
          host: "192.168.1.10",
        }).pipe(
          Effect.provide(Layer.mergeAll(emptyConfigLayer, netServiceLayer, spawnerLayer)),
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.flip,
        );

        if (error._tag !== "DevRunnerHostNotProxiableError") {
          assert.fail(`Unexpected error: ${error._tag}`);
        }
        assert.equal(error.mode, "dev");
        assert.equal(error.host, "192.168.1.10");
        assert.include(error.message, "0.0.0.0");
        assert.include(error.message, "--share");
      });
    });

    // A shared origin means a remote browser, where unbundled dev's
    // per-module waterfall pays a tailnet round trip per import level. The
    // runner defaults bundled dev on for the spawned stack, but only
    // defaults: an explicit GOAT_BUNDLED_DEV (even "0") must pass through.
    describe("--share spawn wiring", () => {
      const shareSpawned = (input: {
        readonly ambientBundledDev?: string | undefined;
        readonly built?: boolean;
        readonly host?: string;
      }) =>
        Effect.gen(function* () {
          let captured: Record<string, string | undefined> | undefined;
          let vpArgs: ReadonlyArray<string> = [];
          const tailscaleCalls: Array<ReadonlyArray<string>> = [];
          const spawnerLayer = Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make((command) => {
              const spawned = command as unknown as {
                readonly command: string;
                readonly args: ReadonlyArray<string>;
                readonly options?: { readonly env?: Record<string, string | undefined> };
              };
              if (spawned.command === "vp") {
                captured = spawned.options?.env;
                vpArgs = spawned.args;
                return Effect.succeed(mockProcess(0));
              }
              tailscaleCalls.push(spawned.args);
              return Effect.succeed(
                ChildProcessSpawner.makeHandle({
                  pid: ChildProcessSpawner.ProcessId(2),
                  exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
                  isRunning: Effect.succeed(false),
                  kill: () => Effect.void,
                  unref: Effect.succeed(Effect.void),
                  stdin: Sink.drain,
                  stdout: spawned.args.includes("status")
                    ? Stream.make(
                        new TextEncoder().encode(
                          JSON.stringify({ Self: { DNSName: "host.example.ts.net." } }),
                        ),
                      )
                    : Stream.empty,
                  stderr: Stream.empty,
                  all: Stream.empty,
                  getInputFd: () => Sink.drain,
                  getOutputFd: () => Stream.empty,
                }),
              );
            }),
          );

          yield* runDevRunnerWithInput({
            ...devServerInput,
            mode: "dev",
            port: undefined,
            share: true,
            built: input.built ?? false,
            host: input.host,
          }).pipe(
            Effect.provide(Layer.mergeAll(emptyConfigLayer, netServiceLayer, spawnerLayer)),
            Effect.provideService(HostProcess.Platform, "linux"),
            Effect.provideService(
              HostProcess.Environment,
              input.ambientBundledDev === undefined
                ? {}
                : { GOAT_BUNDLED_DEV: input.ambientBundledDev },
            ),
          );

          return { env: captured, vpArgs, tailscaleCalls };
        });

      it.effect("keeps an explicit GOAT_BUNDLED_DEV=0 opt-out", () =>
        Effect.gen(function* () {
          const { env } = yield* shareSpawned({ ambientBundledDev: "0" });
          assert.equal(env?.GOAT_BUNDLED_DEV, "0");
        }),
      );

      it.effect("--built serves the backend on the web port's tailnet URL", () =>
        Effect.gen(function* () {
          const { env, vpArgs, tailscaleCalls } = yield* shareSpawned({ built: true });
          assert.include(vpArgs, "dev:built");
          assert.equal(env?.GOAT_BUILT_DEV, "1");
          assert.equal(env?.GOAT_BUNDLED_DEV, undefined);
          assert.equal(env?.VITE_DEV_SERVER_URL, `https://host.example.ts.net:${env?.PORT}/`);
          const serve = tailscaleCalls.find((args) => args.includes("--bg"));
          assert.deepEqual(serve?.slice(-2), [
            `--https=${env?.PORT}`,
            `http://127.0.0.1:${env?.GOAT_PORT}`,
          ]);
        }),
      );

      it.effect("--built --host ::1 targets the backend's IPv6 loopback", () =>
        Effect.gen(function* () {
          const { env, tailscaleCalls } = yield* shareSpawned({ built: true, host: "::1" });
          const serve = tailscaleCalls.find((args) => args.includes("--bg"));
          assert.equal(serve?.at(-1), `http://[::1]:${env?.GOAT_PORT}`);
        }),
      );

      it.effect("without --built keeps Vite behind the tailnet URL", () =>
        Effect.gen(function* () {
          const { env, vpArgs, tailscaleCalls } = yield* shareSpawned({});
          assert.include(vpArgs, "dev");
          assert.notInclude(vpArgs, "dev:built");
          assert.equal(env?.GOAT_BUNDLED_DEV, "1");
          const serve = tailscaleCalls.find((args) => args.includes("--bg"));
          assert.equal(serve?.at(-1), `http://localhost:${env?.PORT}`);
        }),
      );
    });

    it.effect.each([
      { mode: "dev", share: false },
      { mode: "dev:web", share: true },
      { mode: "dev:desktop", share: true },
    ] as const)("rejects --built for $mode with share=$share", ({ mode, share }) => {
      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.succeed(mockProcess(0))),
      );

      return Effect.gen(function* () {
        const error = yield* runDevRunnerWithInput({
          ...devServerInput,
          mode,
          port: undefined,
          share,
          built: true,
        }).pipe(
          Effect.provide(Layer.mergeAll(emptyConfigLayer, netServiceLayer, spawnerLayer)),
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.flip,
        );

        assert.equal(error._tag, "DevRunnerBuiltNeedsShareError");
      });
    });

    it.effect("reports non-zero exits without manufacturing a cause", () => {
      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.succeed(mockProcess(17))),
      );

      return Effect.gen(function* () {
        const error = yield* runDevRunnerWithInput(devServerInput).pipe(
          Effect.provide(Layer.mergeAll(emptyConfigLayer, netServiceLayer, spawnerLayer)),
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.flip,
        );

        if (error._tag !== "DevRunnerProcessExitError") {
          assert.fail(`Unexpected error: ${error._tag}`);
        }
        assert.equal(error.mode, "dev:server");
        assert.equal(error.executable, "vp");
        assert.equal(error.argumentCount, 5);
        assert.equal(error.shell, false);
        assert.equal(error.exitCode, 17);
        assert.ok(!("cause" in error));
        assert.notProperty(error, "args");
        assert.notInclude(error.message, "secret-token-value");
      });
    });

    describe("t3 home precedence", () => {
      const makeWorktree = Effect.acquireRelease(
        Effect.sync(() => {
          const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-devrunner-"));
          NodeFS.writeFileSync(
            NodePath.join(root, ".git"),
            "gitdir: /elsewhere/.git/worktrees/x\n",
          );
          return root;
        }),
        (root) => Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
      );

      const spawnedHome = (input: {
        readonly goatHome: string | undefined;
        readonly cwd: string;
        readonly ambientHome: string | undefined;
      }) =>
        Effect.gen(function* () {
          let captured: Record<string, string | undefined> | undefined;
          const spawnerLayer = Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make((command) => {
              captured = (
                command as {
                  readonly options?: { readonly env?: Record<string, string | undefined> };
                }
              ).options?.env;
              return Effect.succeed(mockProcess(0));
            }),
          );

          yield* runDevRunnerWithInput({ ...devServerInput, goatHome: input.goatHome }).pipe(
            Effect.provide(Layer.mergeAll(emptyConfigLayer, netServiceLayer, spawnerLayer)),
            Effect.provideService(HostProcess.Platform, "linux"),
            Effect.provideService(HostProcess.WorkingDirectory, input.cwd),
            // No ~/.t3 here, so these runs never seed from this machine's install.
            Effect.provideService(HostProcess.HomeDirectory, input.cwd),
            Effect.provideService(
              HostProcess.Environment,
              input.ambientHome === undefined ? {} : { GOAT_HOME: input.ambientHome },
            ),
          );

          return captured?.GOAT_HOME;
        });

      it.effect("prefers an explicit --home-dir over the worktree default", () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const root = yield* makeWorktree;
          const home = yield* spawnedHome({
            goatHome: "/tmp/explicit-home",
            cwd: root,
            ambientHome: "/home/user/.t3",
          });
          assert.equal(home, path.resolve("/tmp/explicit-home"));
        }).pipe(Effect.scoped),
      );

      it.effect("treats a blank --home-dir as unset rather than as a selection", () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const root = yield* makeWorktree;
          const home = yield* spawnedHome({
            goatHome: "   ",
            cwd: root,
            ambientHome: "/home/user/.t3",
          });
          assert.equal(home, path.join(path.resolve(root), ".goat"));
        }).pipe(Effect.scoped),
      );

      it.effect("prefers an existing worktree .t3 over an ambient GOAT_HOME", () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const root = yield* makeWorktree;
          yield* Effect.sync(() =>
            NodeFS.mkdirSync(NodePath.join(root, ".t3", "userdata"), { recursive: true }),
          );
          const home = yield* spawnedHome({
            goatHome: undefined,
            cwd: root,
            ambientHome: "/home/user/.t3",
          });
          assert.equal(home, path.join(path.resolve(root), ".t3"));
        }).pipe(Effect.scoped),
      );

      it.effect("seeds a worktree database from the live home only when it has none", () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const root = yield* makeWorktree;
          const home = path.join(root, "home");
          NodeFS.mkdirSync(path.join(home, ".t3", "userdata"), { recursive: true });
          NodeFS.writeFileSync(path.join(home, ".t3", "userdata", "statev2.sqlite"), "");

          const spawnedArgs = (seed: boolean | undefined) =>
            Effect.gen(function* () {
              const spawned: Array<ReadonlyArray<string>> = [];
              const spawnerLayer = Layer.succeed(
                ChildProcessSpawner.ChildProcessSpawner,
                ChildProcessSpawner.make((command) => {
                  spawned.push(
                    (command as unknown as { readonly args: ReadonlyArray<string> }).args,
                  );
                  return Effect.succeed(mockProcess(0));
                }),
              );
              yield* runDevRunnerWithInput({ ...devServerInput, goatHome: undefined, seed }).pipe(
                Effect.provide(Layer.mergeAll(emptyConfigLayer, netServiceLayer, spawnerLayer)),
                Effect.provideService(HostProcess.Platform, "linux"),
                Effect.provideService(HostProcess.WorkingDirectory, root),
                Effect.provideService(HostProcess.HomeDirectory, home),
                Effect.provideService(HostProcess.Environment, {}),
              );
              return spawned.filter((args) =>
                args.some((arg) => arg.endsWith("migrate-dev-db.ts")),
              );
            });

          assert.deepStrictEqual(yield* spawnedArgs(false), []);
          const [seedArgs] = yield* spawnedArgs(undefined);
          assert.includeMembers(
            [...(seedArgs ?? [])],
            [
              NodePath.join(
                NodePath.dirname(import.meta.dirname),
                "apps/server/scripts/migrate-dev-db.ts",
              ),
              "--base-dir",
              path.join(root, ".goat"),
            ],
          );

          // Either database means the worktree already has data.
          for (const name of ["state.sqlite", "statev2.sqlite"]) {
            const file = path.join(root, ".goat", "userdata", name);
            NodeFS.mkdirSync(path.dirname(file), { recursive: true });
            NodeFS.writeFileSync(file, "");
            assert.deepStrictEqual(yield* spawnedArgs(undefined), []);
            NodeFS.rmSync(file);
          }
        }).pipe(Effect.scoped),
      );

      const startDevServer = (root: string, seed: boolean | undefined) =>
        Effect.gen(function* () {
          const spawned: Array<ReadonlyArray<string>> = [];
          const spawnerLayer = Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make((command) => {
              spawned.push((command as unknown as { readonly args: ReadonlyArray<string> }).args);
              return Effect.succeed(mockProcess(0));
            }),
          );
          const exit = yield* runDevRunnerWithInput({
            ...devServerInput,
            goatHome: undefined,
            seed,
          }).pipe(
            Effect.provide(Layer.mergeAll(emptyConfigLayer, netServiceLayer, spawnerLayer)),
            Effect.provideService(HostProcess.Platform, "linux"),
            Effect.provideService(HostProcess.WorkingDirectory, root),
            Effect.provideService(HostProcess.HomeDirectory, root),
            Effect.provideService(HostProcess.Environment, {}),
            Effect.exit,
          );
          return { exit, spawned };
        });

      const seededWritableWorktree = Effect.gen(function* () {
        const root = yield* makeWorktree;
        const stateDir = NodePath.join(root, ".goat", "userdata");
        NodeFS.mkdirSync(stateDir, { recursive: true });
        NodeFS.writeFileSync(NodePath.join(stateDir, "statev2.sqlite"), "");
        NodeFS.chmodSync(NodePath.dirname(stateDir), 0o775);
        NodeFS.chmodSync(stateDir, 0o775);
        return { root, stateDir };
      });

      it.effect.skipIf(isWindows)(
        "makes an existing writable worktree home private before the server starts, seeded or not (#1648)",
        () =>
          Effect.gen(function* () {
            for (const seed of [undefined, false]) {
              const { root, stateDir } = yield* seededWritableWorktree;
              const { exit } = yield* startDevServer(root, seed);
              assert.isTrue(Exit.isSuccess(exit));
              for (const directory of [NodePath.dirname(stateDir), stateDir]) {
                assert.equal(NodeFS.statSync(directory).mode & 0o777, 0o755, directory);
              }
            }
          }).pipe(Effect.scoped),
      );

      it.effect.skipIf(isWindows)(
        "refuses a symlinked worktree userdata and starts nothing (#1648)",
        () =>
          Effect.gen(function* () {
            const root = yield* makeWorktree;
            const target = NodePath.join(root, "elsewhere");
            NodeFS.mkdirSync(target);
            NodeFS.writeFileSync(NodePath.join(target, "statev2.sqlite"), "data");
            NodeFS.mkdirSync(NodePath.join(root, ".goat"));
            NodeFS.symlinkSync(target, NodePath.join(root, ".goat", "userdata"));

            const { exit, spawned } = yield* startDevServer(root, undefined);

            assert.isTrue(Exit.isFailure(exit));
            assert.include(String(exit), "is a symlink");
            assert.deepStrictEqual(spawned, []);
            assert.equal(
              NodeFS.readFileSync(NodePath.join(target, "statev2.sqlite"), "utf8"),
              "data",
            );
          }).pipe(Effect.scoped),
      );

      it.effect(
        "stops before starting anything when the worktree home cannot be prepared (#1648)",
        () =>
          Effect.gen(function* () {
            const root = yield* makeWorktree;
            const home = NodePath.join(root, ".goat");
            NodeFS.writeFileSync(home, "not a directory");

            const { exit, spawned } = yield* startDevServer(root, undefined);

            assert.isTrue(Exit.isFailure(exit));
            assert.include(String(exit), home);
            assert.deepStrictEqual(spawned, []);
          }).pipe(Effect.scoped),
      );

      it.effect.each([
        { sourceBytes: 500 * 1024 * 1024 - 1, shouldSeed: true },
        { sourceBytes: 500 * 1024 * 1024, shouldSeed: true },
        { sourceBytes: 500 * 1024 * 1024 + 1, shouldSeed: false },
      ])(
        "checks source size before seeding an empty worktree: $sourceBytes bytes",
        ({ sourceBytes, shouldSeed }) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* makeWorktree;
            const home = path.join(root, "home");
            const source = path.join(home, ".t3", "userdata", "statev2.sqlite");
            NodeFS.mkdirSync(path.dirname(source), { recursive: true });
            NodeFS.writeFileSync(source, "");
            const spawned: Array<ReadonlyArray<string>> = [];
            const warnings: Array<string> = [];
            const spawnerLayer = Layer.succeed(
              ChildProcessSpawner.ChildProcessSpawner,
              ChildProcessSpawner.make((command) => {
                spawned.push((command as unknown as { readonly args: ReadonlyArray<string> }).args);
                return Effect.succeed(mockProcess(0));
              }),
            );

            yield* runDevRunnerWithInput({ ...devServerInput, goatHome: undefined }).pipe(
              Effect.provide([
                emptyConfigLayer,
                netServiceLayer,
                spawnerLayer,
                Logger.layer([
                  Logger.make((options) => {
                    if (options.logLevel === "Warn") warnings.push(String(options.message));
                  }),
                ]),
              ]),
              Effect.provideService(FileSystem.FileSystem, {
                ...fs,
                stat: (file) =>
                  fs
                    .stat(file)
                    .pipe(
                      Effect.map((info) =>
                        file === source ? { ...info, size: ByteSize.bytes(sourceBytes) } : info,
                      ),
                    ),
              }),
              Effect.provideService(HostProcess.Platform, "linux"),
              Effect.provideService(HostProcess.WorkingDirectory, root),
              Effect.provideService(HostProcess.HomeDirectory, home),
              Effect.provideService(HostProcess.Environment, {}),
            );

            assert.equal(
              spawned.some((args) => args.some((arg) => arg.endsWith("migrate-dev-db.ts"))),
              shouldSeed,
            );
            assert.deepStrictEqual(spawned.at(-1), [
              "run",
              "--filter=t3",
              "dev",
              ...devServerInput.runArgs,
            ]);
            if (shouldSeed) {
              assert.deepStrictEqual(warnings, []);
            } else {
              assert.lengthOf(warnings, 1);
              assert.include(warnings[0]!, source);
              assert.include(warnings[0]!, "skipping automatic database seeding");
              assert.include(warnings[0]!, "vp run migrate-dev-db");
            }
          }).pipe(Effect.scoped),
      );

      it.effect("falls back to an ambient GOAT_HOME outside a worktree", () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const home = yield* spawnedHome({
            goatHome: undefined,
            cwd: NodeOS.tmpdir(),
            ambientHome: "/home/user/.t3",
          });
          assert.equal(home, path.resolve("/home/user/.t3"));
        }),
      );

      it.effect("prefers the worktree home over an ambient GOAT_HOME", () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const root = yield* makeWorktree;
          const home = yield* spawnedHome({
            goatHome: undefined,
            cwd: root,
            ambientHome: "/home/user/.t3",
          });
          assert.equal(home, path.join(path.resolve(root), ".goat"));
        }).pipe(Effect.scoped),
      );
    });
  });
});

describe("server dev watch", () => {
  it("covers workspace package sources and excludes package roots, where Vite and installs write", () => {
    const repo = NodePath.resolve(import.meta.dirname, "..");
    const serverPackage = JSON.parse(
      NodeFS.readFileSync(NodePath.join(repo, "apps/server/package.json"), "utf8"),
    ) as { readonly scripts: { readonly dev: string } };
    const watched = [...serverPackage.scripts.dev.matchAll(/--watch-path=(\S+)/g)].map(
      ([, path]) => path,
    );
    const packageSources = NodeFS.readdirSync(NodePath.join(repo, "packages"))
      .filter((name) => NodeFS.existsSync(NodePath.join(repo, "packages", name, "src")))
      .map((name) => `../../packages/${name}/src`);

    assert.deepStrictEqual(
      watched.sort(),
      [
        "src",
        "package.json",
        ...packageSources,
        // Runtime code outside src: source-control-github/src/server/pullRequestReads.graphql.ts
        // imports it.
        "../../packages/source-control-github/schema",
      ].sort(),
    );
  });
});
