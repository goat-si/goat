import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import { createBuildConfig } from "./build-desktop-artifact.ts";
import {
  checkReleaseAssetSet,
  releaseAppImageName,
  releaseAssetKey,
  releaseAssetVersion,
  requiredReleaseAssets,
} from "./lib/release-verify.ts";

const withUpdateFeed = Effect.provide(
  ConfigProvider.layer(
    ConfigProvider.fromEnv({
      env: {
        GOAT_DESKTOP_UPDATE_FEED_ENABLED: "true",
        GOAT_DESKTOP_UPDATE_REPOSITORY: "goat-si/goat-releases",
      },
    }),
  ),
);

const appImageName = (version: string) =>
  createBuildConfig("linux", "AppImage", version, false, false, undefined, undefined).pipe(
    Effect.map((config) => (config.appImage as { artifactName: string }).artifactName),
    withUpdateFeed,
  );

it.layer(NodeServices.layer)("version-free AppImage names", (it) => {
  it.effect("names updatable AppImages without a version and apart per channel", () =>
    Effect.gen(function* () {
      const stable = yield* appImageName("0.1.11");
      const nightly = yield* appImageName("0.1.11-nightly.20261118.380");

      assert.equal(stable, "GOAT-${arch}.${ext}");
      assert.equal(nightly, "GOAT-Nightly-${arch}.${ext}");
    }),
  );

  it.effect("the release verifier expects the names the build publishes", () =>
    Effect.gen(function* () {
      for (const version of ["0.1.11", "0.1.11-nightly.20261118.380"]) {
        const pattern = yield* appImageName(version);
        for (const arch of ["arm64", "x86_64"] as const) {
          const published = pattern.replace("${arch}", arch).replace("${ext}", "AppImage");
          assert.equal(releaseAppImageName(version, arch), published);
          assert.include(requiredReleaseAssets(version), published);
        }
      }
    }),
  );
});

it("verifies version-free AppImages by key, without a version of their own", () => {
  assert.equal(releaseAssetKey("GOAT-x86_64.AppImage"), "desktop-linux-x64");
  assert.equal(releaseAssetKey("GOAT-Nightly-arm64.AppImage"), "desktop-linux-arm64");
  assert.isUndefined(releaseAssetVersion("GOAT-x86_64.AppImage"));
  assert.isUndefined(releaseAssetVersion("GOAT-Nightly-arm64.AppImage"));
  assert.equal(releaseAssetVersion("GOAT-0.1.11-amd64.deb"), "0.1.11");
  const version = "0.1.11";
  const required = requiredReleaseAssets(version);
  assert.deepEqual(checkReleaseAssetSet(required, version), []);
  // A versioned AppImage would not update in place, so it no longer belongs to a release.
  assert.deepEqual(
    checkReleaseAssetSet(
      required.map((name) =>
        name === "GOAT-x86_64.AppImage" ? `GOAT-${version}-x86_64.AppImage` : name,
      ),
      version,
    ),
    ["missing asset: GOAT-x86_64.AppImage", `unexpected asset: GOAT-${version}-x86_64.AppImage`],
  );
});
