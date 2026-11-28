import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { goatRemoteMcpConfig } from "../src/engines/opencode/goatMcpConfig.ts";
import { resolveOpenCodeConfigContent } from "../src/engines/opencode/openCodeConfigContent.ts";

test("OpenCode GOAT MCP entry follows the v1 remote config shape", () => {
  const authorization = `Bearer ${randomUUID()}`;
  assert.deepEqual(goatRemoteMcpConfig("http://127.0.0.1:1/mcp", authorization), {
    type: "remote", url: "http://127.0.0.1:1/mcp", headers: { Authorization: authorization }, oauth: false,
  });
});

test("OpenCode config content prefers launch environment, then inherited environment", () => {
  assert.equal(resolveOpenCodeConfigContent({ OPENCODE_CONFIG_CONTENT: "launch" }, { OPENCODE_CONFIG_CONTENT: "inherited" }), "launch");
  assert.equal(resolveOpenCodeConfigContent({}, { OPENCODE_CONFIG_CONTENT: "inherited" }), "inherited");
  assert.equal(resolveOpenCodeConfigContent(undefined, {}), "{}");
});
