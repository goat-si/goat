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
// Synthetic, shaped like a token another server minted.
const FOREIGN = "f".repeat(51);
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
      // A secret that ends with the start of its own tag.
      `${TAG}${"a".repeat(42)}t\n`,
      // Tokens another server minted, ending like a credential name or a registered tag.
      `Authorization: Bearer ${"a".repeat(47)}-GOA\n`,
      `Authorization: Bearer ${"b".repeat(48)}tes\n`,
      `GOAT_MCP_BEARER_TOKEN=${"c".repeat(47)}-Bea\n`,
      // Labels whose assignment or escaped space is still arriving.
      `{"GOAT_MCP_BEARER_TOKEN":"${FOREIGN}"}\n`,
      `${JSON.stringify(JSON.stringify({ GOAT_MCP_BEARER_TOKEN: FOREIGN }))}\n`,
      `GOAT_MCP_BEARER_TOKEN = ${FOREIGN}\n`,
      `Authorization: Bearer\\ ${FOREIGN}\n`,
      `GOAT_ACP_MCP_AUTHORIZATION=Bearer\\ ${FOREIGN}\n`,
      `GOAT_MCP_BEARER_TOKEN=${TOKEN}\0PATH=/usr/bin\0`,
      // A complete credential that runs on into what looks like the start of another.
      `${TAG}GOAT_ACP_MCP_AUTHORIZATION: \n`,
      `bearerGOAT_MCP_BEARER_TOKEN :\tGOAT_MCP_BEARER_TOKEN \n`,
      // A token ending in a label, followed by a word that may start a name.
      `Authorization: Bearer ${"f".repeat(44)}-Bearer ${"x".repeat(52)}GOA\n`,
      `Authorization: Bearer ${TOKEN.slice(0, 44)}-Bearer ${"x".repeat(52)}GOA\n`,
    ];
    for (const output of outputs) {
      for (let first = 1; first < output.length; first += 1) {
        for (let second = first; second <= output.length; second += 1) {
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

  it("streams random mixes of labels, escapes and tokens exactly as whole-text redaction", () => {
    // A fixed seed keeps the cases the same on every run.
    const parts = [
      "GOAT_MCP_BEARER_TOKEN",
      "GOAT_ACP_MCP_AUTHORIZATION",
      "Bearer",
      "bearer",
      "Bearer\\",
      " ",
      "\t",
      "=",
      ":",
      '"',
      "'",
      "\\",
      "\n",
      "\0",
      ",",
      "{",
      TAG,
      "test",
      "GOA",
      "-",
      "a".repeat(20),
      "f".repeat(43),
      FOREIGN,
      "Authorization: ",
      "-Bearer",
      "x".repeat(52),
      TAG + "x".repeat(250),
    ];
    let seed = 12_345;
    const random = (bound: number) => {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7f_ff_ff_ff;
      return seed % bound;
    };
    for (let index = 0; index < 20_000; index += 1) {
      let output = "";
      for (let count = 2 + random(16); count > 0; count -= 1) output += parts[random(parts.length)];
      const cuts = Array.from({ length: 1 + random(6) }, () => random(output.length + 1));
      const bounds = [0, ...cuts.toSorted((a, b) => a - b), output.length];
      const chunks = bounds.slice(1).map((end, at) => output.slice(bounds[at], end));
      expect(streamed(chunks).shown, JSON.stringify(chunks)).toBe(redactGoatCredentials(output));
    }
  });

  it("finds the same credentials near the cut as in the whole text", () => {
    // Back-to-back tagged runs whose matches realign when scanned from a later offset.
    let output = `${TAG}${"x".repeat(119)}`.repeat(7).slice(0, 801);
    output = `${output.slice(0, 389)}${"S".repeat(43)}${output.slice(432)}`;
    expect(streamed([output, "\n"]).shown).toBe(redactGoatCredentials(`${output}\n`));
  });

  it("holds back at most a short tail, whatever the output", () => {
    const flood = Array.from({ length: 10 }, () => " ".repeat(10_000));
    expect(streamed(["GOAT_ACP_MCP_AUTHORIZATION=Bearer", ...flood]).maxCarry).toBeLessThan(400);
    expect(streamed(["a".repeat(60_000), "!"]).maxCarry).toBeLessThan(400);
    expect(streamed(["GOAT_MCP_BEARER_TOKEN=" + "x".repeat(60_000)]).maxCarry).toBeLessThan(400);
    // Values past MAX_VALUE stream exactly as whole-text redaction shows them.
    const long = `GOAT_MCP_BEARER_TOKEN=${"x".repeat(300)}\n`;
    const tagged = `GOAT_MCP_BEARER_TOKEN=${TAG}${"x".repeat(258)}\n`;
    for (const output of [long, tagged]) {
      for (let cut = 1; cut < output.length; cut += 1) {
        expect(streamed([output.slice(0, cut), output.slice(cut)]).shown).toBe(
          redactGoatCredentials(output),
        );
      }
    }
  });
});
