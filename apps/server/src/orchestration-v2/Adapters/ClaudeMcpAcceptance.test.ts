import type { ElicitationRequest } from "@anthropic-ai/claude-agent-sdk";
import { assert, describe, it } from "@effect/vitest";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";

describe("ClaudeAdapterV2 MCP elicitation acceptance", () => {
  const form = (
    properties: Record<string, unknown>,
    required?: ReadonlyArray<string>,
  ): ElicitationRequest => ({
    serverName: "deploys",
    message: "Deploy web?",
    mode: "form",
    requestedSchema: { type: "object", properties, ...(required ? { required } : {}) },
  });

  it("answers an empty-properties form with empty content", () => {
    assert.deepEqual(ClaudeAdapterV2.claudeMcpElicitationAcceptance(form({})), {
      action: "accept",
      content: {},
    });
  });

  it("picks the one-time choice however the server spells it", () => {
    for (const choice of [
      "allow_once",
      "Allow",
      "accept_once",
      "Approve once",
      "allow_this_time",
      "allow_once_only",
    ]) {
      assert.deepEqual(
        ClaudeAdapterV2.claudeMcpElicitationAcceptance(
          form({ decision: { type: "string", enum: ["disallow", choice, "always"] } }, [
            "decision",
          ]),
        ),
        { action: "accept", content: { decision: choice } },
      );
    }
  });

  it("answers a persistence toggle with false", () => {
    assert.deepEqual(
      ClaudeAdapterV2.claudeMcpElicitationAcceptance(
        form({ remember: { type: "boolean", title: "Always allow" } }, ["remember"]),
      ),
      { action: "accept", content: { remember: false } },
    );
  });

  it("leaves out optional fields the card does not show", () => {
    assert.deepEqual(
      ClaudeAdapterV2.claudeMcpElicitationAcceptance(
        form({ scope: { type: "string", enum: ["once", "always"], default: "always" } }),
      ),
      { action: "accept", content: { scope: "once" } },
    );
    assert.deepEqual(
      ClaudeAdapterV2.claudeMcpElicitationAcceptance(
        form({ limit: { type: "number", default: 500 } }),
      ),
      { action: "accept", content: {} },
    );
  });

  it("has no answer for URL mode or a form asking for a value", () => {
    for (const request of [
      { serverName: "deploys", message: "Sign in", mode: "url", url: "https://example.com" },
      form({ reason: { type: "string" } }, ["reason"]),
      form({ grant: { type: "string", enum: ["always", "session"] } }, ["grant"]),
      form({ grant: { type: "string", enum: ["deny", "always"], default: "always" } }, ["grant"]),
      form({ limit: { type: "number", default: 500 } }, ["limit"]),
      { serverName: "deploys", message: "Deploy web?", mode: "form" },
    ] satisfies ReadonlyArray<ElicitationRequest>) {
      assert.isUndefined(ClaudeAdapterV2.claudeMcpElicitationAcceptance(request));
    }
  });
});
