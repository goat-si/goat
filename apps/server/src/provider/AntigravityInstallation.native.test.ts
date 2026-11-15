import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as AntigravityInstallation from "./AntigravityInstallation.ts";
import {
  harnessContents,
  hostPlatform,
  makeHarness,
  previousReleaseId,
  previousVersion,
  serverContents,
  terminalState,
} from "./AntigravityInstallation.testkit.ts";
import * as ModelManifest from "./ModelManifest.ts";

// Ported from upstream 4099e62767's AntigravityInstallation.test.ts; titles kept.
const expectPreviousRelease = Effect.fn("test.expectPreviousAntigravityRelease")(function* (
  installation: AntigravityInstallation.AntigravityInstallation["Service"],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolved = yield* installation.resolve();
  expect(resolved.version).toBe(previousVersion);
  expect(resolved.managedVersionDirectory).toBe(
    path.join(installation.managedDirectory, "versions", previousReleaseId),
  );
  expect(yield* fs.readFileString(resolved.executablePath)).toBe(serverContents);
  expect(yield* fs.readFileString(resolved.harnessPath ?? "")).toBe(harnessContents);
  expect((yield* installation.state).installedVersion).toBe(previousVersion);
});

it.layer(NodeServices.layer)("Antigravity native CLI installation", (it) => {
  it.effect.each([...new Set(["win32", hostPlatform])] as NodeJS.Platform[])(
    "migrates the legacy managed runtime to the native CLI on %s and retains the old release",
    (platform) =>
      Effect.gen(function* () {
        const archive =
          platform === "win32"
            ? Buffer.from(serverContents)
            : Buffer.from(
                "H4sIAAAAAAACE+3RMQ7CQAwEQNe8Ik8wgYj3XIFQCiiOCxK/56CJRA9CYqZZrxsXLpc2n2q5ze0en5LdYZpe2b1n5rhf5+d+m+MuY8j4guXaSu3n4z+V9f9DXXo5HzcBAAAAAAAAAADAz3sA56lbdQAoAAA=",
                "base64",
              );
        const { installation, validations, requests, fs, baseDir, stagingReleased } =
          yield* makeHarness({ native: true, archive, platform, previous: true });
        yield* installation.start;
        expect(yield* terminalState(installation)).toMatchObject({
          phase: "succeeded",
          installedVersion: "1.5.7",
        });
        yield* Deferred.await(stagingReleased);
        const resolved = yield* installation.resolve();
        expect(resolved).toMatchObject({ source: "managed", version: "1.5.7", harnessPath: null });
        expect(validations[0]?.executable.harnessPath).toBeNull();
        expect(yield* fs.readFileString(resolved.executablePath)).toBe(serverContents);
        expect(requests.some((url) => url.includes("/manifests/"))).toBe(true);
        const restarted = yield* makeHarness({
          baseDir,
          native: true,
          archive,
          platform,
          nativeVersion: "1.5.6",
        });
        expect(yield* restarted.installation.start).toMatchObject({
          phase: "verifying",
          message: "Checking the installed runtime.",
        });
        expect(yield* terminalState(restarted.installation)).toMatchObject({
          phase: "succeeded",
          installedVersion: "1.5.7",
        });
        expect(restarted.requests.filter((url) => url.includes("storage.googleapis.com"))).toEqual(
          [],
        );
        expect((yield* restarted.installation.resolve()).executablePath).toBe(
          resolved.executablePath,
        );
      }),
  );

  // These tar fixtures exercise the POSIX extraction path; Windows downloads one executable.
  it.effect.skipIf(hostPlatform === "win32")(
    "rejects unsafe native tar members before activation",
    () =>
      Effect.gen(function* () {
        for (const archive of [
          "H4sIAAAAAAACE+3OMQqDQBAFUI/iCYxZJPdZMIRtFHQN5PYOKbW2EN5j4P9iYCZPtXyW/C3111ylD69h+Gc45rk/U4r1NnXdI2be6lrG90XPbWvNS5xvAAAAAAAAAAAA4D523kNDtgAoAAA=",
          "H4sIAAAAAAACE+3RMQ7CMBAEQNe8Ii8IBhzxHhcIpYDCcSLxewwNiJ4IiZlmb6+54vp+m691PJe8jPUWviI2x2F4ZvOZMe7Ta37sdzGlQ+hiWME81Vza+fCf3p7flbmVy2kTAAAAAAAAAAAA+Hl3jhn2/wAoAAA=",
          "H4sIAAAAAAACE+3TPQrCQBAG0K09RY4wRoPn2UJCClOsG8Hbu6YJ2CtI3mvmp5li+PJcp7Hkx1Sf6VuiuQzDWpvPGtGft/69P0Z/itRF+oHlXnNp59M+5e3/XVnacLseEnv8v/zLv/wDAAAAAAAAAPyZF/c+VksAKAAA",
        ]) {
          const { installation, validations } = yield* makeHarness({
            native: true,
            archive: Buffer.from(archive, "base64"),
            platform: "linux",
            previous: true,
          });
          yield* installation.start;
          expect((yield* terminalState(installation)).phase).toBe("failed");
          expect(validations).toEqual([]);
          yield* expectPreviousRelease(installation);
        }
      }),
  );

  it.effect("keeps withdrawn native releases from activating or launching", () =>
    Effect.gen(function* () {
      let withdrawn = false;
      const manifest = Effect.sync(() =>
        withdrawn
          ? ({
              ...ModelManifest.BUNDLED_MODEL_MANIFEST,
              compatibility: [
                {
                  driver: "antigravity",
                  t3CodeRange: ">=0.0.42",
                  ranges: [{ range: ">=1.5.7", status: "broken" }],
                },
              ],
            } satisfies ModelManifest.ModelManifestData)
          : ModelManifest.BUNDLED_MODEL_MANIFEST,
      );
      const first = yield* makeHarness({
        native: true,
        archive: Buffer.from(serverContents),
        platform: "win32",
        previous: true,
        manifest,
        validate: () =>
          Effect.sync(() => {
            withdrawn = true;
          }),
      });
      yield* first.installation.start;
      expect((yield* terminalState(first.installation)).phase).toBe("failed");
      yield* expectPreviousRelease(first.installation);
      withdrawn = false;
      const retry = yield* makeHarness({
        baseDir: first.baseDir,
        native: true,
        archive: Buffer.from(serverContents),
        platform: "win32",
        manifest,
      });
      yield* retry.installation.start;
      expect((yield* terminalState(retry.installation)).phase).toBe("succeeded");
      withdrawn = true;
      expect(yield* retry.installation.resolve().pipe(Effect.flip)).toMatchObject({
        operation: "resolve",
      });
      // GOAT adapts upstream here: a start over a withdrawn install falls back to the pinned
      // release instead of failing, and still never launches the withdrawn one.
      expect(yield* retry.installation.start).toMatchObject({ version: "1.4.5" });
      yield* terminalState(retry.installation);
      expect(yield* retry.installation.resolve().pipe(Effect.flip)).toMatchObject({
        operation: "resolve",
      });
      const recovery = yield* makeHarness({
        baseDir: first.baseDir,
        native: true,
        nativeVersion: "1.5.6",
        archive: Buffer.from("recovery runtime"),
        platform: "win32",
        manifest,
      });
      yield* recovery.installation.checkForUpdate;
      expect(yield* recovery.installation.state).toMatchObject({
        installedVersion: "1.5.7",
        version: "1.5.6",
      });
      yield* recovery.installation.start;
      expect(yield* terminalState(recovery.installation)).toMatchObject({
        phase: "succeeded",
        installedVersion: "1.5.6",
      });
    }),
  );

  it.effect("discovers subsequent native releases from Google's CLI channel", () =>
    Effect.gen(function* () {
      const first = yield* makeHarness({
        native: true,
        archive: Buffer.from(serverContents),
        platform: "win32",
      });
      yield* first.installation.start;
      expect((yield* terminalState(first.installation)).phase).toBe("succeeded");
      const initialPath = (yield* first.installation.resolve()).executablePath;
      const next = yield* makeHarness({
        baseDir: first.baseDir,
        native: true,
        nativeVersion: "1.5.8",
        archive: Buffer.from("next runtime"),
        platform: "win32",
      });
      yield* next.installation.start;
      expect(yield* terminalState(next.installation)).toMatchObject({
        phase: "succeeded",
        installedVersion: "1.5.8",
      });
      const nextPath = (yield* next.installation.resolve()).executablePath;
      expect(nextPath).not.toBe(initialPath);
      const republished = yield* makeHarness({
        baseDir: first.baseDir,
        native: true,
        nativeVersion: "1.5.8",
        archive: Buffer.from("republished runtime"),
        platform: "win32",
      });
      yield* republished.installation.start;
      expect((yield* terminalState(republished.installation)).phase).toBe("succeeded");
      expect((yield* republished.installation.resolve()).executablePath).not.toBe(nextPath);
      const offline = yield* makeHarness({
        baseDir: first.baseDir,
        native: true,
        nativeManifest: () => ({}),
        archive: Buffer.from("unused"),
        platform: "win32",
      });
      yield* offline.installation.start;
      expect(yield* terminalState(offline.installation)).toMatchObject({
        phase: "succeeded",
        installedVersion: "1.5.8",
      });
      expect(offline.requests.filter((url) => url.includes("storage.googleapis.com"))).toEqual([]);
    }),
  );
});
