import { describe, expect, it } from "@effect/vitest";

import {
  REDACTED_CREDENTIAL,
  redactGoatCredentialChunk,
  redactGoatCredentials,
  redactGoatCredentialsDeep,
  registerCredentialRunTag,
} from "./goatCredentialRedaction.ts";

// Synthetic, shaped like McpSessionRegistry's run tag plus secret.
const TAG = "testtag0";
const TOKEN = TAG + "SyntheticMcpTokenNotARealCredential00000000";
const SECRET = TOKEN.slice(TAG.length);
registerCredentialRunTag(TAG);

/** What a viewer of streamed chunks ends up seeing. */
function streamed(chunks: ReadonlyArray<string>): {
  readonly shown: string;
  readonly maxCarry: number;
} {
  let carry = "";
  let shown = "";
  let maxCarry = 0;
  for (const chunk of chunks) {
    const next = redactGoatCredentialChunk(carry, chunk);
    shown += next.emit;
    carry = next.carry;
    maxCarry = Math.max(maxCarry, carry.length);
  }
  return { shown: shown + redactGoatCredentials(carry), maxCarry };
}

describe("redactGoatCredentials", () => {
  it("an environment dump in any common form never shows the MCP token", () => {
    const dumps = [
      `HOME=/Users/agent\nGOAT_ACP_MCP_AUTHORIZATION=Bearer ${TOKEN}\nPATH=/usr/bin`,
      `declare -x T3_ACP_MCP_AUTHORIZATION="Bearer ${TOKEN}"`,
      `GOAT_ACP_MCP_AUTHORIZATION=Bearer\\ ${TOKEN}`,
      JSON.stringify({ GOAT_CUA_LEASE_AUTHORIZATION: `Bearer ${TOKEN}` }),
      JSON.stringify(JSON.stringify({ GOAT_ACP_MCP_AUTHORIZATION: `Bearer ${TOKEN}` })),
      JSON.stringify([{ name: "GOAT_MCP_BEARER_TOKEN", value: TOKEN }]),
      `curl -H 'Authorization: Bearer ${TOKEN}' http://127.0.0.1:1234/mcp`,
      `GOAT_MCP_BEARER_TOKEN=${TOKEN}`,
      `token is ${TOKEN}.`,
    ];
    for (const dump of dumps) {
      const redacted = redactGoatCredentials(dump);
      expect(redacted).not.toContain(SECRET.slice(0, 12));
      expect(redacted).toContain(REDACTED_CREDENTIAL);
    }
    expect(redactGoatCredentials(dumps[0]!)).toBe(
      `HOME=/Users/agent\nGOAT_ACP_MCP_AUTHORIZATION=Bearer ${REDACTED_CREDENTIAL}\nPATH=/usr/bin`,
    );
  });

  it("redacts a token another server minted from its variable name and shape", () => {
    const foreign = "otherrun" + "ForeignSyntheticTokenNotARealCredential0000";
    expect(redactGoatCredentials(`GOAT_MCP_BEARER_TOKEN=${foreign}`)).toBe(
      `GOAT_MCP_BEARER_TOKEN=${REDACTED_CREDENTIAL}`,
    );
    expect(redactGoatCredentials(`Authorization: Bearer ${foreign}`)).toBe(
      `Authorization: Bearer ${REDACTED_CREDENTIAL}`,
    );
  });

  it("a snapshot that ends partway through a token shows none of it", () => {
    const snapshot = `GOAT_ACP_MCP_AUTHORIZATION=Bearer ${TOKEN.slice(0, 50)}`;
    expect(redactGoatCredentials(snapshot)).not.toContain(SECRET.slice(0, 12));
    expect(redactGoatCredentials(`echo ${TOKEN.slice(0, 20)}`)).toBe(`echo ${REDACTED_CREDENTIAL}`);
  });

  it("keeps output around a credential intact", () => {
    const text = "GOAT_ACP_MCP_AUTHORIZATION=\nPATH=/usr/bin\nBearer of bad news";
    expect(redactGoatCredentials(text)).toBe(text);
    const nul = `GOAT_MCP_BEARER_TOKEN=${TOKEN}\0PATH=/usr/bin\0TERM=xterm\0`;
    expect(redactGoatCredentials(nul)).toBe(
      `GOAT_MCP_BEARER_TOKEN=${REDACTED_CREDENTIAL}\0PATH=/usr/bin\0TERM=xterm\0`,
    );
    const item = { output: "ok", nested: [{ input: "env" }] };
    expect(redactGoatCredentialsDeep(item)).toBe(item);
  });

  it("redacts every string inside a provider record", () => {
    const item = {
      type: "command_execution",
      input: "env",
      output: `GOAT_ACP_MCP_AUTHORIZATION=Bearer ${TOKEN}`,
      result: { content: [{ type: "text", text: `Bearer ${TOKEN}` }] },
    };
    expect(JSON.stringify(redactGoatCredentialsDeep(item))).not.toContain(SECRET);
  });
});

describe("redactGoatCredentialChunk", () => {
  it("streamed output shows exactly the redacted text wherever chunks split it", () => {
    const outputs = [
      `PWD=/work\nGOAT_ACP_MCP_AUTHORIZATION=Bearer ${TOKEN}\nTERM=xterm\n`,
      `PWD=/work\nGOAT_MCP_BEARER_TOKEN=${TOKEN}\nTERM=xterm\n`,
      `the token is ${TOKEN} ok\n`,
    ];
    for (const output of outputs) {
      for (let first = 1; first < output.length; first += 1) {
        for (const second of [first + 1, first + 7, first + 30]) {
          const chunks = [
            output.slice(0, first),
            output.slice(first, second),
            output.slice(second),
          ];
          expect(streamed(chunks).shown).toBe(redactGoatCredentials(output));
        }
      }
    }
  });

  it("holds back at most a short tail, whatever the output", () => {
    const flood = Array.from({ length: 10 }, () => " ".repeat(10_000));
    expect(streamed(["GOAT_ACP_MCP_AUTHORIZATION=Bearer", ...flood]).maxCarry).toBeLessThan(400);
    expect(streamed(["a".repeat(60_000), "!"]).maxCarry).toBeLessThan(400);
    expect(streamed(["GOAT_MCP_BEARER_TOKEN=" + "x".repeat(60_000)]).maxCarry).toBeLessThan(400);
  });
});
