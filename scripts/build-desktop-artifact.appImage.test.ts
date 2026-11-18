import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import { createBuildConfig } from "./build-desktop-artifact.ts";
import { VERSION_FREE_APPIMAGES } from "./lib/desktop-release-channel.ts";
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

const appImagePattern = (version: string) =>
  createBuildConfig("linux", "AppImage", version, false, false, undefined, undefined).pipe(
    Effect.map((config) => {
      const override = config.appImage as { artifactName?: string } | undefined;
      const pattern = override?.artifactName ?? config.artifactName;
      assert(typeof pattern === "string", "Expected an AppImage artifact name pattern");
      return pattern;
    }),
    withUpdateFeed,
  );

it.layer(NodeServices.layer)("published AppImage names", (it) => {
  it.effect.each([
    { version: "0.1.11", versionFreePattern: "GOAT-${arch}.${ext}" },
    { version: "0.1.11-nightly.20261118.380", versionFreePattern: "GOAT-Nightly-${arch}.${ext}" },
  ])("the build and release verifier agree for $version in the configured mode", (release) =>
    Effect.gen(function* () {
      const { version, versionFreePattern } = release;
      const versionedPattern = "GOAT-${version}-${arch}.${ext}";
      const pattern = yield* appImagePattern(version);
      const alternatePattern = VERSION_FREE_APPIMAGES ? versionedPattern : versionFreePattern;
      assert.equal(pattern, VERSION_FREE_APPIMAGES ? versionFreePattern : versionedPattern);

      const required = requiredReleaseAssets(version);
      assert.deepEqual(checkReleaseAssetSet(required, version), []);
      for (const arch of ["arm64", "x86_64"] as const) {
        const expand = (name: string) =>
          name
            .replace("${version}", version)
            .replace("${arch}", arch)
            .replace("${ext}", "AppImage");
        const published = expand(pattern);
        const alternate = expand(alternatePattern);
        assert.equal(releaseAppImageName(version, arch), published);
        assert.include(required, published);
        assert.deepEqual(
          checkReleaseAssetSet(
            required.map((name) => (name === published ? alternate : name)),
            version,
          ),
          [`missing asset: ${published}`, `unexpected asset: ${alternate}`],
        );
      }
    }),
  );
});

it.each([
  { name: "GOAT-x86_64.AppImage", key: "desktop-linux-x64", version: undefined },
  { name: "GOAT-Nightly-arm64.AppImage", key: "desktop-linux-arm64", version: undefined },
  { name: "GOAT-0.1.11-x86_64.AppImage", key: "desktop-linux-x64", version: "0.1.11" },
  {
    name: "GOAT-0.1.11-nightly.20261118.380-arm64.AppImage",
    key: "desktop-linux-arm64",
    version: "0.1.11-nightly.20261118.380",
  },
  { name: "GOAT-0.1.11-amd64.deb", key: "desktop-linux-x64", version: "0.1.11" },
])("identifies the release asset $name", ({ name, key, version }) => {
  assert.equal(releaseAssetKey(name), key);
  assert.equal(releaseAssetVersion(name), version);
});
