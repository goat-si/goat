import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("Android network configuration trusts system and user CAs and keeps cleartext enabled", async () => {
  const appConfig = fs.readFileSync(path.join(__dirname, "../app.config.ts"), "utf8");
  const pluginPath = appConfig.match(
    /\.\/plugins\/withAndroid(?:CleartextTraffic|NetworkSecurityConfig)\.cjs/,
  )?.[0];
  assert.ok(pluginPath, "Android network plugin must be registered");
  const plugin = require(path.join(__dirname, "..", pluginPath));
  const config = plugin({ name: "test", slug: "test" });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goat-android-network-"));
  try {
    const modRequest = { platformProjectRoot: root };
    const manifest = await config.mods.android.manifest({
      modRequest,
      modResults: { manifest: { application: [{ $: {} }] } },
    });
    assert.equal(
      manifest.modResults.manifest.application[0].$["android:networkSecurityConfig"],
      "@xml/network_security_config",
    );
    await config.mods.android.dangerous({ modRequest });
    const xml = fs.readFileSync(
      path.join(root, "app/src/main/res/xml/network_security_config.xml"),
      "utf8",
    );
    assert.match(xml, /<base-config\s+cleartextTrafficPermitted="true">/);
    assert.match(xml, /<certificates\s+src="system"\s*\/>/);
    assert.match(xml, /<certificates\s+src="user"\s*\/>/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
