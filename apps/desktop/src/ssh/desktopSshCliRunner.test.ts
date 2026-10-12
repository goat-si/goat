import * as Option from "effect/Option";
import { assert, describe, it } from "@effect/vitest";

import { resolveDesktopSshCliRunner } from "./desktopSshCliRunner.ts";

const server = { version: "0.0.45", engines: { node: "^24.13.1" } };
const archiveOptions = {
  archiveDirectory: "/home/me/.goat/runtime/archives",
  releaseBaseUrl: "https://mirror.example/releases/download",
};
const environment = (input: {
  readonly appVersion: string;
  readonly isPackaged: boolean;
  readonly isDevelopment: boolean;
  readonly devRemoteEntry?: string;
}) => ({
  appVersion: input.appVersion,
  isPackaged: input.isPackaged,
  isDevelopment: input.isDevelopment,
  devRemoteGoatServerEntryPath: Option.fromNullishOr(input.devRemoteEntry),
});

describe("resolveDesktopSshCliRunner", () => {
  it("keeps a packaged app's own release, including nightly versions", () => {
    assert.deepStrictEqual(
      resolveDesktopSshCliRunner(
        environment({
          appVersion: "0.0.46-nightly.20261010.7",
          isPackaged: true,
          isDevelopment: false,
        }),
        archiveOptions,
        server,
      ),
      {
        archiveVersion: "0.0.46-nightly.20261010.7",
        ...archiveOptions,
        refreshOwnedRuntimeOnFirstConnection: true,
      },
    );
  });

  it.each([true, false])(
    "uses the server version when unpackaged Electron reports its own (development: %s)",
    (isDevelopment: boolean) => {
      assert.deepStrictEqual(
        resolveDesktopSshCliRunner(
          environment({ appVersion: "44.4.5", isPackaged: false, isDevelopment }),
          archiveOptions,
          server,
        ),
        { archiveVersion: "0.0.45", ...archiveOptions },
      );
    },
  );

  it("runs a configured source checkout in development", () => {
    assert.deepStrictEqual(
      resolveDesktopSshCliRunner(
        environment({
          appVersion: "44.4.5",
          isPackaged: false,
          isDevelopment: true,
          devRemoteEntry: "/src/goat/apps/server/src/bin.ts",
        }),
        archiveOptions,
        server,
      ),
      { nodeScriptPath: "/src/goat/apps/server/src/bin.ts", nodeEngineRange: "^24.13.1" },
    );
  });
});

it("carries read-only packaged resources separately from the writable cache", () => {
  const options = {
    ...archiveOptions,
    bundledArchiveDirectory:
      "/Applications/GOAT Nightly.app/Contents/Resources/ssh-runtime/archives",
  };
  const runner = resolveDesktopSshCliRunner(
    environment({ appVersion: "1.2.3-nightly.1", isPackaged: true, isDevelopment: false }),
    options,
    server,
  );
  assert.equal(runner.bundledArchiveDirectory, options.bundledArchiveDirectory);
  assert.equal(runner.archiveDirectory, archiveOptions.archiveDirectory);
  assert.notEqual(runner.bundledArchiveDirectory, runner.archiveDirectory);
  const dev = resolveDesktopSshCliRunner(
    environment({
      appVersion: "44",
      isPackaged: false,
      isDevelopment: true,
      devRemoteEntry: "/fixture/cli.mjs",
    }),
    options,
    server,
  );
  assert.isUndefined(dev.bundledArchiveDirectory);
});
