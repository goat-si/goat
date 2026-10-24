import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { assert, describe, it } from "vite-plus/test";
import { redacted, scanMemoryValue } from "./MemorySecretScanner.ts";

const decodePayload = Schema.decodeUnknownSync(M.MemoryPayload);

describe("MemorySecretScanner", () => {
  it("redacts GOAT credentials from generated memory text and judgment, leaving the rest (#1297)", () => {
    // A synthetic canary shaped like a registry token; not a real credential.
    const secret = "canaryGeneratedToken".padEnd(43, "0");
    const evidence = [{ origin: "user" as const, messageIds: [] }];
    const resolution = Effect.runSync(
      redacted(
        Effect.succeed({
          result: {
            text: `fact GOAT_MCP_BEARER_TOKEN=${secret}`,
            judgment: `kept Bearer ${secret}`,
            assertionKind: "inference",
            evidence,
          },
          execution: { effectiveModel: "fixture" },
        }),
      ),
    );
    assert.deepStrictEqual(resolution, {
      result: {
        text: "fact GOAT_MCP_BEARER_TOKEN=[redacted]",
        judgment: "kept Bearer [redacted]",
        assertionKind: "inference",
        evidence,
      },
      execution: { effectiveModel: "fixture" },
    });
    // A summary has no judgment and gains none.
    const summary = Effect.runSync(redacted(Effect.succeed({ result: { text: "plain fact" } })));
    assert.deepStrictEqual(summary, { result: { text: "plain fact" } });
  });

  it("blocks fabricated tokens and PEM private keys", () => {
    const sentinel = "sk-" + "A".repeat(32);
    const result = scanMemoryValue({ text: sentinel, judgment: "-----BEGIN PRIVATE KEY-----" });
    assert.deepStrictEqual(result.kind === "blocked" ? result.ruleIds : [], [
      "pem_private_key",
      "provider_token",
    ]);
    assert.notInclude(JSON.stringify(result), sentinel);
  });
  it("screens input output judgment and originals", () => {
    const sentinel = "ghp_" + "Z".repeat(32);
    for (const field of ["payload", "result", "inputs", "originals", "resolutionPayload"])
      assert.strictEqual(
        scanMemoryValue({ [field]: [{ text: sentinel, judgment: sentinel }] }).kind,
        "blocked",
      );
    assert.strictEqual(scanMemoryValue({ messages: [{ text: sentinel }] }).kind, "blocked");
  });
  it("allows ordinary memory prose", () => {
    assert.deepStrictEqual(
      scanMemoryValue({ text: "Prefer targeted checks. Keep the default model options." }),
      { kind: "allowed" },
    );
    assert.deepStrictEqual(scanMemoryValue({ environmentId: "sk-" + "A".repeat(32) }), {
      kind: "allowed",
    });
  });
  it("unknown secret-bearing fields cannot enter operation encoding", () => {
    const payload = {
      text: "ordinary",
      evidence: [],
      derivedFromMemoryRevisions: [],
      secret: "sk-" + "A".repeat(32),
    };
    assert.throws(() => decodePayload(payload, { onExcessProperty: "error" }));
  });
  it("pre-admission blocked operation keeps metadata only", () => {
    const sentinel = "xoxb-" + "A".repeat(32);
    const result = scanMemoryValue({ payload: { text: sentinel } });
    assert.strictEqual(result.kind, "blocked");
    assert.notInclude(JSON.stringify(result), sentinel);
    assert.deepStrictEqual(Object.keys(result).sort(), ["inspectedBytes", "kind", "ruleIds"]);
  });
});
