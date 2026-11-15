import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  makeHarness,
  previousVersion,
  serverContents,
  terminalState,
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
});
