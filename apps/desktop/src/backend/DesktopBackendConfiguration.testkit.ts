import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopBackendConfiguration from "./DesktopBackendConfiguration.ts";
import * as DesktopShellEnvironment from "../shell/DesktopShellEnvironment.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopServerExposure from "./DesktopServerExposure.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";
import * as DesktopWslServerTree from "../wsl/DesktopWslServerTree.ts";

const layerShellEnvironment = (prepared = true) =>
  Layer.succeed(DesktopShellEnvironment.DesktopShellEnvironment, {
    installIntoProcess: Effect.succeed(prepared),
    awaitDiscovery: Effect.succeed(prepared),
    updates: Stream.empty,
  });
export const layerBackendConfiguration = (prepared = true) =>
  DesktopBackendConfiguration.layer.pipe(
    Layer.provide(layerShellEnvironment(prepared)),
    Layer.provide(DesktopState.layer),
  );
export const layerServerExposure = Layer.succeed(DesktopServerExposure.DesktopServerExposure, {
  getState: Effect.die("unexpected getState"),
  backendConfig: Effect.succeed({
    port: 4888,
    bindHost: "0.0.0.0",
    httpBaseUrl: new URL("http://127.0.0.1:4888"),
    tailscaleServeEnabled: true,
    tailscaleServePort: 8443,
  }),
  configureFromSettings: () => Effect.die("unexpected configureFromSettings"),
  setMode: () => Effect.die("unexpected setMode"),
  setTailscaleServeEnabled: () => Effect.die("unexpected setTailscaleServeEnabled"),
  getAdvertisedEndpoints: Effect.succeed([]),
} satisfies DesktopServerExposure.DesktopServerExposure["Service"]);
export function layerEnvironment(
  baseDir: string,
  options?: {
    readonly omitHomeOverride?: boolean;
    readonly appPath?: string;
    readonly dirname?: string;
    readonly isPackaged?: boolean;
    readonly devServerUrl?: string;
    readonly platform?: NodeJS.Platform;
    readonly resourcesPath?: string;
    readonly appVersion?: string;
    readonly processArch?: NodeJS.Architecture;
    readonly otlpTracesUrl?: string;
    readonly otlpMetricsUrl?: string;
    readonly otlpLogsUrl?: string;
  },
) {
  return DesktopEnvironment.layer({
    dirname: options?.dirname ?? "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: options?.platform ?? "darwin",
    processArch: options?.processArch ?? "x64",
    appVersion: options?.appVersion ?? "1.2.3",
    appPath: options?.appPath ?? "/repo",
    isPackaged: options?.isPackaged ?? true,
    resourcesPath: options?.resourcesPath ?? "/missing/resources with spaces",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        DesktopConfig.layerTest({
          GOAT_HOME: options?.omitHomeOverride ? undefined : baseDir,
          GOAT_PORT: "9999",
          GOAT_MODE: "desktop",
          GOAT_DESKTOP_LAN_HOST: "192.168.1.50",
          VITE_DEV_SERVER_URL: options?.devServerUrl,
          GOAT_OTLP_TRACES_URL: options?.otlpTracesUrl,
          GOAT_OTLP_METRICS_URL: options?.otlpMetricsUrl,
          GOAT_OTLP_LOGS_URL: options?.otlpLogsUrl,
        }),
      ),
    ),
  );
}
export const restoreEnv = (name: string, value: string | undefined) => {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
};
export const withHarness = <A, E, R>(
  effect: Effect.Effect<
    A,
    E,
    | R
    | DesktopEnvironment.DesktopEnvironment
    | FileSystem.FileSystem
    | DesktopBackendConfiguration.DesktopBackendConfiguration
  >,
  prepared = true,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "goat-desktop-backend-config-test-",
    });
    return yield* effect.pipe(
      Effect.provide(
        layerBackendConfiguration(prepared).pipe(
          Layer.provideMerge(layerServerExposure),
          Layer.provideMerge(DesktopAppSettings.layerTest()),
          Layer.provideMerge(DesktopWslEnvironment.layerTest()),
          Layer.provideMerge(DesktopWslServerTree.layerTest()),
          Layer.provideMerge(layerEnvironment(baseDir)),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));
interface PackagedWslHarnessContext {
  readonly baseDir: string;
  readonly archivePath: string;
  readonly hashPath: string;
  readonly archiveHash: string;
  readonly mountedAppRoot: string;
  readonly mountedEntryPath: string;
}

export const withPackagedWslHarness = <A, E, R>(
  input: {
    readonly archiveHash: string;
    readonly wsl: (
      context: PackagedWslHarnessContext,
    ) => DesktopWslEnvironment.DesktopWslEnvironmentTestStub;
    readonly forbidFallback?: string;
    readonly cleanupLegacy?: Effect.Effect<void>;
    readonly forbidCleanup?: string;
  },
  effect: (
    context: PackagedWslHarnessContext,
  ) => Effect.Effect<
    A,
    E,
    R | FileSystem.FileSystem | Path.Path | DesktopBackendConfiguration.DesktopBackendConfiguration
  >,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "goat-desktop-backend-config-test-",
    });
    const archivePath = path.join(baseDir, "wsl-runtime.tar.gz");
    const hashPath = `${archivePath}.sha256`;
    const mountedAppRoot = "/mnt/c/app.asar.unpacked";
    const mountedEntryPath = path.join(baseDir, "app.asar.unpacked/apps/server/dist/bin.mjs");
    yield* fileSystem.makeDirectory(path.dirname(mountedEntryPath), { recursive: true });
    yield* fileSystem.writeFileString(mountedEntryPath, "");
    yield* fileSystem.writeFileString(archivePath, "archive");
    yield* fileSystem.writeFileString(hashPath, `${input.archiveHash}\n`);

    const context = {
      baseDir,
      archivePath,
      hashPath,
      archiveHash: input.archiveHash,
      mountedAppRoot,
      mountedEntryPath,
    } satisfies PackagedWslHarnessContext;
    const layerServerTree = input.forbidFallback
      ? Layer.succeed(
          DesktopWslServerTree.DesktopWslServerTree,
          DesktopWslServerTree.DesktopWslServerTree.of({
            ensure: Effect.die(input.forbidFallback),
            cleanupLegacy: input.forbidCleanup
              ? Effect.die(input.forbidCleanup)
              : (input.cleanupLegacy ?? Effect.void),
          }),
        )
      : DesktopWslServerTree.layerTest({
          result: { ok: true, root: path.join(baseDir, "app.asar.unpacked") },
          cleanupLegacy: input.cleanupLegacy ?? Effect.void,
        });

    return yield* effect(context).pipe(
      Effect.provide(
        layerBackendConfiguration().pipe(
          Layer.provideMerge(layerServerExposure),
          Layer.provideMerge(DesktopAppSettings.layerTest()),
          Layer.provideMerge(layerServerTree),
          Layer.provideMerge(
            DesktopWslEnvironment.layerTest({
              isAvailable: true,
              distros: [{ name: "Ubuntu", isDefault: true, version: 2 }],
              windowsToWslPath: () => Option.some(mountedAppRoot),
              getDistroIp: () => Option.some("172.27.0.99"),
              ...input.wsl(context),
            }),
          ),
          Layer.provideMerge(
            layerEnvironment(baseDir, {
              appPath: baseDir,
              platform: "win32",
              resourcesPath: baseDir,
            }),
          ),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));
