import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
import { test } from "vitest";

const require = NodeModule.createRequire(import.meta.url);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));

test("Android network configuration trusts system and user CAs and keeps cleartext enabled", async () => {
  const appConfig = NodeFS.readFileSync(NodePath.join(__dirname, "../app.config.ts"), "utf8");
  const pluginPath = appConfig.match(
    /\.\/plugins\/withAndroid(?:CleartextTraffic|NetworkSecurityConfig)\.cjs/,
  )?.[0];
  NodeAssert.ok(pluginPath, "Android network plugin must be registered");
  const plugin = require(NodePath.join(__dirname, "..", pluginPath));
  const config = plugin({ name: "test", slug: "test" });
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-android-network-"));
  try {
    const modRequest = { platformProjectRoot: root };
    const manifest = await config.mods.android.manifest({
      modRequest,
      modResults: { manifest: { application: [{ $: {} }] } },
    });
    NodeAssert.equal(
      manifest.modResults.manifest.application[0].$["android:networkSecurityConfig"],
      "@xml/network_security_config",
    );
    await config.mods.android.dangerous({ modRequest });
    const xml = NodeFS.readFileSync(
      NodePath.join(root, "app/src/main/res/xml/network_security_config.xml"),
      "utf8",
    );
    NodeAssert.match(xml, /<base-config\s+cleartextTrafficPermitted="true">/);
    NodeAssert.match(xml, /<certificates\s+src="system"\s*\/>/);
    NodeAssert.match(xml, /<certificates\s+src="user"\s*\/>/);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
