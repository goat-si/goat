import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createMuseHost, museEnvironment, museServeArgs } from "../src/engines/muse/sdk.ts";
import * as fixture from "./fakes/muse-sdk.ts";

const fixturePath = fileURLToPath(new URL("./fakes/muse-sdk.ts", import.meta.url));

test("Muse SDK host configures and closes the handshake", async () => {
  fixture.reset();
  process.env.GOAT2_ENGINE_HELPER_SDK_MUSE = fixturePath;
  try {
    const { close } = await createMuseHost({ binary: "fixture", args: ["--flag"], cwd: "/tmp", env: { meta_api_key: "private", TEST: "value" }, fullAccess: true });
    assert.deepEqual(fixture.calls[0], { command: "fixture", args: ["--flag", "serve", "--trust-workspace", "--disable-sandbox"], cwd: "/tmp", env: { TEST: "value", MUSE_NO_AUTO_UPDATE: "1" }, shutdownTimeoutMs: 10000 });
    assert.deepEqual(fixture.calls[1], { clientInfo: { name: "t3_code", title: "T3 Code", version: "1" }, capabilities: { requestedCapabilities: ["sessionMcp"] } });
    await Promise.all([close(), close()]);
    assert.equal(fixture.closes, 1);
  } finally { delete process.env.GOAT2_ENGINE_HELPER_SDK_MUSE; }
});

test("failed handshake closes the child", async () => {
  fixture.reset();
  process.env.GOAT2_ENGINE_HELPER_SDK_MUSE = fixturePath;
  process.env.GOAT2_MUSE_FAKE_FAIL = "1";
  try {
    await assert.rejects(createMuseHost({ binary: "fixture" }), /fixture failure/);
    assert.equal(fixture.closes, 1);
  } finally {
    delete process.env.GOAT2_ENGINE_HELPER_SDK_MUSE;
    delete process.env.GOAT2_MUSE_FAKE_FAIL;
  }
});

test("Muse serve defaults and environment are safe", () => {
  assert.deepEqual(museServeArgs(false), ["serve", "--trust-workspace"]);
  assert.deepEqual(museEnvironment({ META_API_KEY: "private", HOME: "/tmp" }), { HOME: "/tmp", MUSE_NO_AUTO_UPDATE: "1" });
});
