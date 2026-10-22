import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, assert, describe, it, vi } from "@effect/vitest";
import { LEGACY_RESOURCE_MONITOR_BINARY_NAME } from "@goat/contracts/legacyT3Names";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import * as ResourceMonitorBinary from "./ResourceMonitorBinary.ts";

// The override checks POSIX exec bits on a real file under a linux platform
// mock; NTFS never reports those bits, so the check cannot be satisfied there.
const windowsHost = HostProcess.Platform.defaultValue() === "win32";

describe("ResourceMonitorBinary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.effect.each(["darwin", "win32", "linux"] as const)(
    "prefers the new bundled monitor and falls back to a legacy development build on %s",
    (platform) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "goat-monitor-fallback-",
        });
        const suffix = platform === "win32" ? ".exe" : "";
        const bundledPath = path.resolve(
          import.meta.dirname,
          "resource-monitor",
          `${platform}-x64`,
          `goat-resource-monitor${suffix}`,
        );
        const legacyPath = path.resolve(
          import.meta.dirname,
          "../../../../native/resource-monitor/target/release",
          `${LEGACY_RESOURCE_MONITOR_BINARY_NAME}${suffix}`,
        );
        const stat = yield* fileSystem.stat(baseDir);
        const available = new Set([bundledPath, legacyPath]);
        const mockFileSystem = FileSystem.makeNoop({
          exists: (candidate) => Effect.succeed(available.has(candidate)),
          stat: () => Effect.succeed({ ...stat, type: "File", mode: 0o755 }),
        });
        const config = yield* ServerConfig.ServerConfig.pipe(
          Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
        );
        const service = yield* ResourceMonitorBinary.make().pipe(
          Effect.provideService(ServerConfig.ServerConfig, config),
          Effect.provideService(HostProcess.Platform, platform),
          Effect.provideService(HostProcess.Architecture, "x64"),
          Effect.provideService(ResourceMonitorBinary.ResourceMonitorHostLinuxLibc, "gnu"),
          Effect.provideService(HostProcess.Environment, {}),
          Effect.provideService(FileSystem.FileSystem, mockFileSystem),
        );
        assert.equal(yield* service.resolve, bundledPath);
        available.delete(bundledPath);
        assert.equal(yield* service.resolve, legacyPath);
        const legacyBundledPath = path.join(
          path.dirname(bundledPath),
          `${LEGACY_RESOURCE_MONITOR_BINARY_NAME}${suffix}`,
        );
        available.clear();
        available.add(legacyBundledPath);
        assert.equal(yield* service.resolve, legacyBundledPath);
        const developmentPath = path.join(
          path.dirname(legacyPath),
          `goat-resource-monitor${suffix}`,
        );
        available.add(developmentPath);
        assert.equal(yield* service.resolve, developmentPath);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.skipIf(windowsHost)("resolves an executable override on an unsupported platform", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "goat-resource-monitor-binary-",
      });
      const binaryPath = `${baseDir}/custom-resource-monitor`;
      yield* fileSystem.writeFileString(binaryPath, "binary");
      yield* fileSystem.chmod(binaryPath, 0o755);

      const service = yield* ResourceMonitorBinary.make().pipe(
        Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
        Effect.provideService(HostProcess.Platform, "freebsd"),
        Effect.provideService(HostProcess.Architecture, "ia32"),
        Effect.provideService(HostProcess.Environment, {
          GOAT_RESOURCE_MONITOR_PATH: binaryPath,
        }),
      );

      assert.equal(yield* service.resolve, binaryPath);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a non-executable POSIX override", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "goat-resource-monitor-binary-",
      });
      const binaryPath = `${baseDir}/goat-resource-monitor`;
      yield* fileSystem.writeFileString(binaryPath, "binary");
      yield* fileSystem.chmod(binaryPath, 0o644);

      const service = yield* ResourceMonitorBinary.make().pipe(
        Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.Architecture, "x64"),
        Effect.provideService(ResourceMonitorBinary.ResourceMonitorHostLinuxLibc, "gnu"),
        Effect.provideService(HostProcess.Environment, {
          GOAT_RESOURCE_MONITOR_PATH: binaryPath,
        }),
      );
      const error = yield* Effect.flip(service.resolve);

      assert.instanceOf(error, ResourceMonitorBinary.ResourceMonitorBinaryNotExecutable);
      assert.equal(error.path, binaryPath);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  // regression: #16838 a directory resolved as the resource monitor binary
  it.effect("rejects a directory override", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "goat-resource-monitor-binary-",
      });

      const service = yield* ResourceMonitorBinary.make().pipe(
        Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(HostProcess.Architecture, "arm64"),
        Effect.provideService(HostProcess.Environment, {
          GOAT_RESOURCE_MONITOR_PATH: baseDir,
        }),
      );
      const error = yield* Effect.flip(service.resolve);

      assert.instanceOf(error, ResourceMonitorBinary.ResourceMonitorBinaryNotExecutable);
      assert.equal(error.path, baseDir);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects bundled glibc binaries on musl Linux hosts", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "goat-resource-monitor-binary-",
      });
      const service = yield* ResourceMonitorBinary.make().pipe(
        Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.Architecture, "x64"),
        Effect.provideService(ResourceMonitorBinary.ResourceMonitorHostLinuxLibc, "musl"),
        Effect.provideService(HostProcess.Environment, {}),
      );
      const error = yield* Effect.flip(service.resolve);

      assert.instanceOf(error, ResourceMonitorBinary.ResourceMonitorBinaryUnsupported);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
