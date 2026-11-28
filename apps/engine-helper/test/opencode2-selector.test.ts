import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyOpenCodeCliVersion, classifyOpenCodeProbeResponse, selectOpenCodeRuntime } from "../src/engines/opencode2/select.ts";
import { capabilitiesForOpenCode2 } from "../src/engines/opencode2/capabilities.ts";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opencodeEngine } from "../src/engines/opencode/index.ts";
import { probeOpenCode2 } from "../src/engines/opencode2/probe.ts";

test("classifies CLI versions with v1 token boundaries and prereleases", () => {
  assert.deepEqual(classifyOpenCodeCliVersion("opencode v2.0.3-rc.2 (linux)"), { generation: "v2", version: "2.0.3-rc.2" });
  assert.deepEqual(classifyOpenCodeCliVersion("opencode 1.19.4"), { generation: "v1", version: "1.19.4" });
  assert.equal(classifyOpenCodeCliVersion("build2.0.3artifact"), undefined);
  assert.equal(classifyOpenCodeCliVersion("opencode 2.0.0-01"), undefined);
});

test("requires the expected JSON server shape and recognizes unauthorized", () => {
  const data = { status: 200, contentType: "application/json; charset=utf-8", body: '{"version":"2.0.28","pid":1}' };
  assert.deepEqual(classifyOpenCodeProbeResponse("/api/info", data), { generation: "v2", version: "2.0.28" });
  assert.equal(classifyOpenCodeProbeResponse("/global/health", data), undefined);
  assert.equal(classifyOpenCodeProbeResponse("/api/info", { ...data, contentType: "text/html" }), undefined);
  assert.equal(classifyOpenCodeProbeResponse("/api/info", { ...data, status: 401 }), "unauthorized");
});

test("unavailable binary fails without exposing its path", async () => {
  await assert.rejects(selectOpenCodeRuntime({ binary: "/not-present/opencode" }), /^Error: Unable to determine OpenCode version/);
});

test("a missing CLI short-circuits both probe paths before server startup", { timeout: 1000 }, async () => {
  const launch = { binary: "/definitely-not-an-opencode-binary", args: [], env: { GOAT2_ENGINE_HELPER_SDK_OPENCODE: "", GOAT2_ENGINE_HELPER_SDK_OPENCODE2: "" } };
  const params = { protocol: 1, engine: "opencode" as const, cwd: process.cwd(), launch };
  const host = { now: () => "2026-01-01T00:00:00Z", emit() {}, log() {}, fail(reason: string) { throw new Error(reason); } };
  let starts = 0;
  const direct = await probeOpenCode2(params, host, { startRuntime: async () => { starts++; throw new Error("must not start"); } });
  const selected = await opencodeEngine.probe!(params, host);
  for (const result of [direct, selected]) { assert.equal(result.installed, false); assert.equal(result.cli, "missing"); assert.equal(result.status, "error"); }
  assert.equal(starts, 0);
});

test("version selection honors the launch arguments, cwd, and environment", async () => {
  const dir = await mkdtemp(join(tmpdir(), "goat-opencode-select-"));
  try {
    const script = join(dir, "fake.mjs");
    await writeFile(script, "if (process.argv[2] !== 'sentinel' || process.argv[3] !== '--version' || process.env.GOAT_TEST_VERSION !== '2.0.28' || process.cwd() !== process.env.GOAT_TEST_CWD) process.exit(3); console.log('opencode ' + process.env.GOAT_TEST_VERSION);\n");
    const found = await selectOpenCodeRuntime({ binary: process.execPath, args: [script, "sentinel"], cwd: dir, environment: { ...process.env, GOAT_TEST_VERSION: "2.0.28", GOAT_TEST_CWD: await realpath(dir) } });
    assert.deepEqual(found, { generation: "v2", version: "2.0.28" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("2.x capabilities match v1 and native goals start at 2.2.5 stable", async () => {
  const native = JSON.parse(await readFile(new URL("../../../crates/goat2-engine-sdk/src/capabilities/opencode2.json", import.meta.url), "utf8"));
  assert.deepEqual(capabilitiesForOpenCode2("2.0.28"), { ...native, sessions: { sourceRestriction: "published-ref", executionLocation: "local", followUp: { supported: true }, ...native.sessions }, turns: { ...native.turns, supportsNativeGoals: false } });
  assert.equal(capabilitiesForOpenCode2("2.2.5-rc.1").turns.supportsNativeGoals, false);
  assert.equal(capabilitiesForOpenCode2("2.2.5").turns.supportsNativeGoals, true);
  assert.equal(capabilitiesForOpenCode2("2.2.6-rc.1").turns.supportsNativeGoals, true);
});
