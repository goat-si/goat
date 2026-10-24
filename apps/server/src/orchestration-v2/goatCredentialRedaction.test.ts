import { describe, expect, it } from "vitest";

import {
  REDACTED_CREDENTIAL,
  redactGoatCredentialChunk,
  redactGoatCredentials,
  redactGoatCredentialsDeep,
} from "./goatCredentialRedaction.ts";

// Synthetic, shaped like McpSessionRegistry's run tag plus secret.
const TOKEN = "testtag0" + "SyntheticMcpTokenNotARealCredential00000000";

describe("redactGoatCredentials", () => {
  it("an environment dump in any common format never shows the MCP token", () => {
    const dumps = [
      `HOME=/Users/agent\nGOAT_ACP_MCP_AUTHORIZATION=Bearer ${TOKEN}\nPATH=/usr/bin`,
      `declare -x T3_ACP_MCP_AUTHORIZATION="Bearer ${TOKEN}"`,
      JSON.stringify({ GOAT_CUA_LEASE_AUTHORIZATION: `Bearer ${TOKEN}` }),
      JSON.stringify(JSON.stringify({ GOAT_ACP_MCP_AUTHORIZATION: `Bearer ${TOKEN}` })),
      `curl -H 'Authorization: Bearer ${TOKEN}' http://127.0.0.1:1234/mcp`,
      `GOAT_ACP_MCP_AUTHORIZATION=${TOKEN.slice(8)}`,
    ];
    expect(TOKEN).toHaveLength(51);
    for (const dump of dumps) {
      const redacted = redactGoatCredentials(dump);
      expect(redacted).not.toContain(TOKEN.slice(8));
      expect(redacted).toContain(REDACTED_CREDENTIAL);
    }
    expect(redactGoatCredentials(dumps[0]!)).toBe(
      `HOME=/Users/agent\nGOAT_ACP_MCP_AUTHORIZATION=Bearer ${REDACTED_CREDENTIAL}\nPATH=/usr/bin`,
    );
  });

  it("leaves output without a GOAT credential unchanged", () => {
    const text = "GOAT_ACP_MCP_AUTHORIZATION=\nPATH=/usr/bin\nBearer of bad news";
    expect(redactGoatCredentials(text)).toBe(text);
    const item = { output: "ok", nested: [{ input: "env" }] };
    expect(redactGoatCredentialsDeep(item)).toBe(item);
  });

  it("redacts every string inside a turn item", () => {
    const item = {
      type: "command_execution",
      input: "env",
      output: `GOAT_ACP_MCP_AUTHORIZATION=Bearer ${TOKEN}`,
      result: { content: [{ type: "text", text: `Bearer ${TOKEN}` }] },
    };
    expect(JSON.stringify(redactGoatCredentialsDeep(item))).not.toContain(TOKEN);
  });

  it("streamed output never shows the token wherever the chunks split it", () => {
    const output = `PWD=/work\nGOAT_ACP_MCP_AUTHORIZATION=Bearer ${TOKEN}\nTERM=xterm\n`;
    for (let first = 1; first < output.length; first += 1) {
      for (const second of [first + 1, first + 7, first + 30]) {
        const chunks = [output.slice(0, first), output.slice(first, second), output.slice(second)];
        let carry = "";
        let shown = "";
        for (const chunk of chunks) {
          const next = redactGoatCredentialChunk(carry, chunk);
          shown += next.emit;
          carry = next.carry;
        }
        shown += redactGoatCredentials(carry);
        expect(shown).toBe(redactGoatCredentials(output));
      }
    }
  });
});
