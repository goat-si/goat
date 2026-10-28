import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import { createBuildConfig, renderMacEntitlements } from "./build-desktop-artifact.ts";

it.layer(NodeServices.layer)("macOS signing entitlements", (it) => {
  it.effect("signs every macOS build for the microphone without a passkey profile", () =>
    Effect.gen(function* () {
      const config = yield* createBuildConfig("mac", "dmg", "1.2.3", true, false, undefined, {
        entitlementsPath: "/tmp/entitlements.mac.plist",
        entitlementsInheritPath: "/tmp/entitlements.mac.inherit.plist",
      });
      const mac = config.mac as Record<string, unknown>;
      assert.match(String(mac.sign), /[\\/]scripts[\\/]sign-macos\.ts$/);
      assert.notProperty(mac, "provisioningProfile");
      assert.equal(mac.entitlements, "/tmp/entitlements.mac.plist");
      assert.equal(mac.entitlementsInherit, "/tmp/entitlements.mac.inherit.plist");
      const info = mac.extendInfo as Record<string, unknown>;
      assert.notProperty(info, "NSCameraUsageDescription");
      assert.equal(
        info.NSMicrophoneUsageDescription,
        "GOAT uses this Mac's microphone for voice input and for commands run by terminals and coding agents, including work started from connected devices. After you allow access, those commands can record without asking again.",
      );

      // Electron helpers capture audio too, so they get the same base entitlements and never
      // the passkey identity keys.
      const base = renderMacEntitlements();
      assert.match(base, /<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\/>/u);
      assert.include(base, "<key>com.apple.security.cs.allow-jit</key>");
      assert.notInclude(base, "com.apple.security.device.camera");
      assert.notInclude(base, "com.apple.application-identifier");
      assert.notInclude(base, "com.apple.developer.associated-domains");
      assert.notInclude(base, "keychain-access-groups");
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))),
  );
});
