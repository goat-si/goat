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
        hostDownload: true,
        publishedFallback: true,
        attachAppServer: true,
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
        {
          archiveVersion: "0.0.45",
          ...archiveOptions,
          hostDownload: true,
          publishedFallback: true,
          attachAppServer: true,
        },
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

  it("asks for the archive with this build's commit time so same-core runtimes can be ordered", () => {
    const commitTime = 1_791_000_000;
    const packaged = resolveDesktopSshCliRunner(
      environment({
        appVersion: "0.1.0-nightly.20261017.1",
        isPackaged: true,
        isDevelopment: false,
      }),
      archiveOptions,
      server,
      commitTime,
    );
    assert.equal(packaged.archiveVersion, "0.1.0-nightly.20261017.1");
    assert.equal(packaged.archiveCommitTime, commitTime);

    const unstamped = resolveDesktopSshCliRunner(
      environment({
        appVersion: "0.1.0-nightly.20261017.1",
        isPackaged: true,
        isDevelopment: false,
      }),
      archiveOptions,
      server,
      undefined,
    );
    assert.notProperty(unstamped, "archiveCommitTime");

    // A source checkout runs whatever is on disk, so no archive build is ordered.
    const source = resolveDesktopSshCliRunner(
      environment({
        appVersion: "44.4.5",
        isPackaged: false,
        isDevelopment: true,
        devRemoteEntry: "/src/goat/apps/server/src/bin.ts",
      }),
      archiveOptions,
      server,
      commitTime,
    );
    assert.notProperty(source, "archiveCommitTime");
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
