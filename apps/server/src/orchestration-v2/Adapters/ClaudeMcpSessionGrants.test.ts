import type { ElicitationRequest } from "@anthropic-ai/claude-agent-sdk";
import { assert, describe, it } from "@effect/vitest";
import { makeClaudeMcpSessionGrants } from "./ClaudeMcpSessionGrants.ts";

const request: ElicitationRequest = {
  serverName: "server",
  displayName: "app",
  title: "title",
  message: "approve?",
  mode: "form",
  requestedSchema: {
    type: "object",
    properties: { a: { type: "string" }, b: { type: "boolean" } },
  },
};
const result = { action: "accept", content: { decision: "once" } } as const;

describe("Claude MCP session grants", () => {
  it("uses the full identity and canonical schema, and preserves the approved content", () => {
    const grants = makeClaudeMcpSessionGrants();
    grants.remember(request, result);
    assert.deepEqual(
      grants.get({
        ...request,
        requestedSchema: {
          properties: { b: { type: "boolean" }, a: { type: "string" } },
          type: "object",
        },
      }),
      result,
    );
    for (const changed of [
      { ...request, serverName: "other" },
      { ...request, displayName: "other" },
      { ...request, title: "other" },
      { ...request, message: "other" },
      { ...request, requestedSchema: { type: "object", properties: {} } },
    ])
      assert.isUndefined(grants.get(changed));
  });

  it("never caches an oversized UTF-8 key or a grant beyond the count limit", () => {
    const grants = makeClaudeMcpSessionGrants();
    const oversized = { ...request, message: "한".repeat(3000) };
    grants.remember(oversized, result);
    assert.isUndefined(grants.get(oversized));
    for (let i = 0; i < 65; i++) grants.remember({ ...request, message: `${i}` }, result);
    assert.deepEqual(grants.get({ ...request, message: "0" }), result);
    assert.isUndefined(grants.get({ ...request, message: "64" }));
  });
});
