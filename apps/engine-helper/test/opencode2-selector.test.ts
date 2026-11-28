import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyOpenCodeCliVersion, classifyOpenCodeProbeResponse, selectOpenCodeRuntime } from "../src/engines/opencode2/select.ts";

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
