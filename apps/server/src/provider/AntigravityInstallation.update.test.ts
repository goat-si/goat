import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import {
  makeHarness,
  previousVersion,
  releaseAsset,
  serverContents,
  terminalState,
  writeRelease,
} from "./AntigravityInstallation.testkit.ts";
import * as ModelManifest from "./ModelManifest.ts";

const PINNED_WINDOWS_URL =
  "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.5-windows-x86_64.zip";
const isNativeDownload = (url: string) => url.startsWith("https://storage.googleapis.com/");
const isManifest = (url: string) => url.includes("/manifests/windows_amd64.json");
const withdrawing = (range: string) =>
  Effect.succeed({
    ...ModelManifest.BUNDLED_MODEL_MANIFEST,
    compatibility: [
      { driver: "antigravity", t3CodeRange: ">=0.0.42", ranges: [{ range, status: "broken" }] },
    ],
  } satisfies ModelManifest.ModelManifestData);

it.layer(NodeServices.layer)("Antigravity managed CLI updates", (it) => {
  it.effect(
    "offers Google's native CLI and installs it once its SHA-512 matches the manifest",
    () =>
      Effect.gen(function* () {
        const { installation, requests, validations } = yield* makeHarness({
          native: true,
          platform: "win32",
          archive: Buffer.from(serverContents),
        });
        yield* installation.checkForUpdate;
        expect((yield* installation.state).version).toBe("1.5.7");
        yield* installation.start;
        expect(yield* terminalState(installation)).toMatchObject({
          phase: "succeeded",
          installedVersion: "1.5.7",
        });
        const resolved = yield* installation.resolve();
        expect(resolved).toMatchObject({ source: "managed", version: "1.5.7", harnessPath: null });
        expect(validations[0]?.executable.harnessPath).toBeNull();
        expect(requests.filter(isNativeDownload)).toHaveLength(1);
      }),
  );

  it.effect(
    "keeps the pinned release and downloads no update while the manifest is unreachable",
    () =>
      Effect.gen(function* () {
        const { installation, requests } = yield* makeHarness({
          native: true,
          platform: "win32",
          archive: Buffer.from(serverContents),
          nativeManifest: () => null,
        });
        yield* installation.checkForUpdate;
        expect((yield* installation.state).version).toBe("1.4.5");
        const started = yield* installation.start;
        expect(started.version).toBe("1.4.5");
        yield* terminalState(installation);
        expect(requests.filter(isManifest)).toHaveLength(2);
        expect(requests.filter(isNativeDownload)).toEqual([]);
        expect(requests.at(-1)).toBe(PINNED_WINDOWS_URL);
      }),
  );

  it.effect("installs nothing when the native download's SHA-512 differs from the manifest", () =>
    Effect.gen(function* () {
      const { installation, requests } = yield* makeHarness({
        native: true,
        platform: "win32",
        previous: true,
        archive: Buffer.from(serverContents),
        nativeManifest: (manifest) => ({ ...manifest, sha512: "0".repeat(128) }),
      });
      yield* installation.start;
      const failed = yield* terminalState(installation);
      expect(failed.phase).toBe("failed");
      expect(failed.message).toContain("checksum");
      expect(requests.filter(isNativeDownload)).toHaveLength(1);
      expect((yield* installation.resolve()).version).toBe(previousVersion);
    }),
  );

  it.effect("does not offer or install a release the model manifest withdrew", () =>
    Effect.gen(function* () {
      const { installation, requests } = yield* makeHarness({
        native: true,
        platform: "win32",
        archive: Buffer.from(serverContents),
        manifest: withdrawing(">=1.5.7"),
      });
      yield* installation.checkForUpdate;
      expect((yield* installation.state).version).toBe("1.4.5");
      yield* installation.start;
      yield* terminalState(installation);
      expect(requests.filter(isManifest)).toHaveLength(2);
      expect(requests.filter(isNativeDownload)).toEqual([]);
    }),
  );

  it.effect("ignores a manifest that points outside Google's storage host", () =>
    Effect.gen(function* () {
      const { installation, requests } = yield* makeHarness({
        native: true,
        platform: "win32",
        archive: Buffer.from(serverContents),
        nativeManifest: (manifest) => ({
          ...manifest,
          url: manifest.url.replace("storage.googleapis.com", "storage.example.com"),
        }),
      });
      yield* installation.checkForUpdate;
      expect((yield* installation.state).version).toBe("1.4.5");
      yield* installation.start;
      yield* terminalState(installation);
      expect(requests.filter(isManifest)).toHaveLength(2);
      expect(requests.some((url) => url.includes("storage.example.com"))).toBe(false);
    }),
  );

  it.effect("refuses a redirected native download", () =>
    Effect.gen(function* () {
      const { installation, requests } = yield* makeHarness({
        native: true,
        platform: "win32",
        previous: true,
        archive: Buffer.from(serverContents),
        redirectTo: "https://mirror.example.com/cli_windows_x64.exe",
      });
      yield* installation.start;
      const failed = yield* terminalState(installation);
      expect(failed.phase).toBe("failed");
      expect(requests.filter(isNativeDownload)).toHaveLength(1);
      expect(requests).not.toContain("https://mirror.example.com/cli_windows_x64.exe");
      expect((yield* installation.resolve()).version).toBe(previousVersion);
    }),
  );

  it.effect("a restart over native 1.5.7 offers 1.5.7, never the pinned 1.4.5", () =>
    Effect.gen(function* () {
      const first = yield* makeHarness({
        native: true,
        platform: "win32",
        archive: Buffer.from(serverContents),
      });
      yield* first.installation.start;
      expect((yield* terminalState(first.installation)).installedVersion).toBe("1.5.7");
      const offline = yield* makeHarness({
        baseDir: first.baseDir,
        native: true,
        platform: "win32",
        archive: Buffer.from(serverContents),
        nativeManifest: () => null,
      });
      expect((yield* offline.installation.state).version).toBe("1.5.7");
      yield* offline.installation.checkForUpdate;
      expect((yield* offline.installation.state).version).toBe("1.5.7");
      const withdrawnNext = yield* makeHarness({
        baseDir: first.baseDir,
        native: true,
        nativeVersion: "1.5.8",
        platform: "win32",
        archive: Buffer.from(serverContents),
        manifest: withdrawing(">=1.5.8"),
      });
      yield* withdrawnNext.installation.checkForUpdate;
      expect(yield* withdrawnNext.installation.state).toMatchObject({
        installedVersion: "1.5.7",
        version: "1.5.7",
      });
    }),
  );

  it.effect.each(["1.5.0", "2.0.0"])(
    "offers Google's %s only once the model manifest marks it supported",
    (version) =>
      Effect.gen(function* () {
        const { installation, requests } = yield* makeHarness({
          native: true,
          nativeVersion: version,
          platform: "win32",
          archive: Buffer.from(serverContents),
        });
        yield* installation.checkForUpdate;
        expect((yield* installation.state).version).toBe("1.4.5");
        yield* installation.start;
        yield* terminalState(installation);
        expect(requests.filter(isNativeDownload)).toEqual([]);
        expect(requests.at(-1)).toBe(PINNED_WINDOWS_URL);
      }),
  );

  it.effect("an installed release the manifest does not list keeps running", () =>
    Effect.gen(function* () {
      const unlisted = { ...(yield* releaseAsset()), version: "1.5.0" };
      const first = yield* makeHarness({ asset: unlisted });
      yield* first.installation.start;
      expect((yield* terminalState(first.installation)).installedVersion).toBe("1.5.0");
      const later = yield* makeHarness({
        baseDir: first.baseDir,
        native: true,
        nativeVersion: "2.0.0",
      });
      expect((yield* later.installation.resolve()).version).toBe("1.5.0");
      yield* later.installation.checkForUpdate;
      expect((yield* later.installation.state).version).toBe("1.5.0");
    }),
  );

  it.effect.each([
    ["the pin while Google's channel is unreachable", () => null, "1.4.5"],
    ["Google's supported release", undefined, "1.5.8"],
  ] as const)(
    "a restart over an install the 1.1.1 pin recorded as agy_acp_server_1.1.1 offers %s",
    ([, nativeManifest, offered]) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-agy-legacy-" });
        yield* writeRelease(`${baseDir}/tools/antigravity-acp/win32-x64`, {
          ...(yield* releaseAsset(undefined, "win32")),
          sha256: "2".repeat(64),
          version: "agy_acp_server_1.1.1",
        });
        const { installation } = yield* makeHarness({
          baseDir,
          native: true,
          nativeVersion: "1.5.8",
          platform: "win32",
          archive: Buffer.from(serverContents),
          ...(nativeManifest === undefined ? {} : { nativeManifest }),
        });
        expect((yield* installation.state).installedVersion).toBe("agy_acp_server_1.1.1");
        yield* installation.checkForUpdate;
        expect((yield* installation.state).version).toBe(offered);
      }),
  );
});
