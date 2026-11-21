import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as ServerConfig from "./config.ts";
import { cleanupFixture, runCleanupTest } from "./storageCleanup.testkit.ts";

it.live.each([
  { kind: "logs", name: "server.log.1", label: "rotated logs" },
  { kind: "browser-artifacts", name: "capture.png", label: "browser artifacts" },
] as const)("skips dangling symlinks during $kind cleanup", ({ kind, name, label }) =>
  runCleanupTest(
    Effect.gen(function* () {
      const { service, fs, config, enableFiles, disable } = yield* cleanupFixture();
      disable();
      enableFiles();
      const directory = kind === "logs" ? `${config.logsDir}/nested` : config.browserArtifactsDir;
      yield* fs.makeDirectory(directory, { recursive: true });
      const expired = `${directory}/${name}`;
      const dangling = `${directory}/00-dangling-${name}`;
      const linked = `${directory}/01-linked-${name}`;
      yield* fs.symlink("missing", dangling);
      yield* fs.symlink(directory, linked);
      yield* fs.writeFileString(expired, "expired");
      yield* fs.utimes(expired, 1, 1);

      const report = yield* service.runNow;
      expect(report.entries.filter((entry) => entry.kind === kind)).toMatchObject([
        { outcome: "removed", reason: `Removed 1 ${label}`, files: 1, bytes: 7 },
      ]);
      expect((yield* fs.readDirectory(directory)).toSorted()).toEqual([
        `00-dangling-${name}`,
        `01-linked-${name}`,
      ]);
    }),
  ),
);
it.live("keeps external rotated logs when a scanned directory is replaced by a symlink", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      yield* fs.makeDirectory(config.logsDir, { recursive: true });
      const nested = `${yield* fs.realPath(config.logsDir)}/nested`;
      const outside = yield* fs.makeTempDirectoryScoped();
      const expired = `${outside}/server.log.1`;
      yield* fs.makeDirectory(nested);
      yield* fs.writeFileString(expired, "external log");
      yield* fs.utimes(expired, 1, 1);

      const { service, enableFiles, disable } = yield* cleanupFixture().pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          readDirectory: (directory, options) =>
            Effect.gen(function* () {
              if (directory === nested) {
                yield* fs.rename(nested, `${nested}-original`);
                yield* fs.symlink(outside, nested);
              }
              return yield* fs.readDirectory(directory, options);
            }),
        }),
      );
      disable();
      enableFiles();
      const report = yield* service.runNow;
      expect(yield* fs.exists(expired)).toBe(true);
      expect(report.entries.find((entry) => entry.kind === "logs")).toMatchObject({
        outcome: "kept",
        reason: "No expired files",
      });
    }),
  ),
);
