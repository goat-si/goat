import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import { legacyToolNameTargets } from "@goat/contracts/agentSurface/resolve";
import { layerTestLoopback } from "@goat/shared/testing/loopbackHttpServer";
import * as Effect from "effect/Effect";
import { type McpSchema, McpServer } from "effect/ai";
import { HttpBody, HttpClient } from "effect/http";
import { serveCatalogOverHttp } from "./agentSurface.testkit.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { DEPRECATED_META_KEY, decodeMcpNameHeader, listedMcpNameHeader } from "./ToolDispatch.ts";

const legacy = "orchestrator_capabilities";
const listed = "goat_provider_list";
const base64 = (value: string) => `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;

const thread: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:legacy-tool-name"),
  requestNamespace: "legacy-tool-name",
  issuedAt: 0,
  capabilities: new Set(["orchestration"] as const),
  grantedScopes: [],
  thread: {
    threadId: ThreadId.make("thread:legacy-tool-name"),
    providerSessionId: "session:legacy-tool-name",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
};

it("reads an Mcp-Name header exactly as Effect's MCP server does", () => {
  const headers = [
    listed,
    legacy,
    "",
    " padded ",
    "tab\there",
    "caf\u00e9",
    "line\nbreak",
    base64(legacy),
    base64("ünïcödé"),
    base64(""),
    "=?base64?not base64?=",
    `=?base64?${Buffer.from([0xff, 0xfe]).toString("base64")}?=`,
    "=?base64?",
    "=?base64?=",
    "=?BASE64?b3JjaA==?=",
  ];
  for (const header of headers)
    expect(decodeMcpNameHeader(header), JSON.stringify(header)).toBe(
      McpServer.decodeNameHeader(header),
    );
});

it("follows a legacy name's Mcp-Name header only when it named that legacy tool", () => {
  const call = { legacy, listed };
  // 2025-06-18 sends no header: the body alone is rewritten, as before.
  expect(listedMcpNameHeader(undefined, call)).toEqual({ _tag: "Absent" });
  expect(listedMcpNameHeader(legacy, call)).toEqual({ _tag: "Listed", value: listed });
  expect(listedMcpNameHeader(base64(legacy), call)).toEqual({ _tag: "Listed", value: listed });
  // A header that did not name the body's tool is never made to match it.
  for (const header of [listed, "goat_task_create", "", "=?base64?not base64?=", base64(listed)])
    expect(listedMcpNameHeader(header, call), header).toBeUndefined();
  // The listed name is written as a plain header, which every rewrite target must allow.
  for (const target of new Set(legacyToolNameTargets.values())) {
    expect(target.startsWith("=?base64?"), target).toBe(false);
    expect(McpServer.decodeNameHeader(target), target).toBe(target);
  }
});

/** A sessionless 2026-07-28 tools/call as Claude Code sends it: the name in the body and header. */
const callStateless = Effect.fnUntraced(function* (name: string, nameHeader: string) {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.post("/mcp", {
    headers: {
      accept: "application/json, text/event-stream",
      authorization: "Bearer thread.token",
      "mcp-method": "tools/call",
      "mcp-name": nameHeader,
      "mcp-protocol-version": "2026-07-28",
    },
    body: HttpBody.text(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name,
          arguments: {},
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": { name: "legacy-tool-name", version: "1" },
          },
        },
      }),
      "application/json",
    ),
  });
  const text = yield* response.text;
  const data = text.split(/\r?\n/).filter((line) => line.startsWith("data:"));
  const answer = JSON.parse(data.length > 0 ? data.at(-1)!.slice(5) : text) as {
    readonly error?: { readonly code?: number };
    readonly result?: McpSchema.CallToolResult;
  };
  return { status: response.status, answer };
});

it.effect(
  "runs a legacy tool name over MCP 2026-07-28 and refuses a mismatched Mcp-Name (#3778)",
  () =>
    Effect.gen(function* () {
      yield* serveCatalogOverHttp({ thread }, "full");
      const byListed = yield* callStateless(listed, listed);
      expect(byListed.status).toBe(200);
      expect(byListed.answer.error).toBeUndefined();
      expect(byListed.answer.result?._meta?.[DEPRECATED_META_KEY]).toBeUndefined();
      // Before the fix these were refused with HTTP 400 / -32020: the body was rewritten to the
      // listed name while the header still named the legacy one.
      for (const header of [legacy, base64(legacy)]) {
        const byLegacy = yield* callStateless(legacy, header);
        expect(byLegacy.status, header).toBe(200);
        expect(byLegacy.answer.error, header).toBeUndefined();
        expect(byLegacy.answer.result?._meta?.[DEPRECATED_META_KEY], header).toBe(listed);
        expect(byLegacy.answer.result?.content, header).toEqual(byListed.answer.result?.content);
      }
      // Before the fix a header naming the listed tool was accepted with a legacy body, because the
      // rewritten body then matched it. Header and body must agree as sent.
      for (const header of [listed, "goat_task_create"]) {
        const mismatched = yield* callStateless(legacy, header);
        expect(mismatched.status, header).toBe(400);
        expect(mismatched.answer.error?.code, header).toBe(-32020);
      }
    }).pipe(Effect.scoped, Effect.provide(layerTestLoopback)),
);
