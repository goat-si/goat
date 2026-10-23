// @effect-diagnostics nodeBuiltinImport:off - the ACP stdio bridge reads a native stream, as it does from an agent.
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import { ALWAYS_LOAD_META_KEY, type AgentToolListing } from "@goat/contracts/agentSurface/listing";
import { listedToolName } from "@goat/contracts/agentSurface/resolve";
import { acpMcpContext } from "@goat/provider-acp/server/mcpContext";
import { makeAcpMcpOverAcpBridge } from "@goat/provider-acp/server/mcpOverAcpBridge";
import type { McpProviderSessionConfig } from "@goat/provider-core/server/mcpSession";
import { cursorMcpServers } from "@goat/provider-cursor/testing";
import { goatRemoteMcpConfig } from "@goat/provider-opencode/testing";
import { buildPiRpcLaunch, loadMcpBridge } from "@goat/provider-pi/testing";
import { NodeHttpServer } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as NodeStream from "node:stream";

import { claudeMcpQueryOverrides } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { codexThreadRuntimeParams } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { buildCodexAdditionalContext } from "../provider/CodexDeveloperInstructions.ts";
import { runAcpMcpStdioBridge } from "./AcpMcpStdioBridge.ts";
import { type ListedTool, serveCatalogOverHttp } from "./agentSurface.testkit.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

/**
 * What each harness is offered of GOAT's tools: its adapter's own MCP configuration, pointed at a
 * served /mcp, listed the way that harness reaches it, then narrowed by the adapter's own filters.
 * Whether a harness then defers the tools it is offered is the harness's choice; the always-load
 * marker is how GOAT asks it not to for goat_describe and goat_call.
 */

const PROTOCOL = "2025-06-18";
const thread: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment"),
  capabilities: new Set(["orchestration", "worktree", "pull-requests", "preview"] as const),
  issuedAt: 0,
  requestNamespace: "provider:thread",
  thread: {
    threadId: ThreadId.make("thread"),
    providerSessionId: "provider:thread",
    providerInstanceId: ProviderInstanceId.make("harness"),
  },
  client: undefined,
};
// The testkit authenticates "Bearer <caller>.token" as that caller.
const session = (endpoint: string): McpProviderSessionConfig => ({
  environmentId: thread.environmentId,
  threadId: ThreadId.make("thread"),
  providerSessionId: "provider:thread",
  providerInstanceId: ProviderInstanceId.make("harness"),
  endpoint,
  authorizationHeader: "Bearer thread.token",
  browserToolsAvailable: true,
});

const CORE = ["goat_call", "goat_describe"];
const threadTools = Object.values(agentSurfaceRegistry)
  .filter((entry) => entry.requires !== "client")
  .map(listedToolName);

/** The served tools a harness keeps, checked against the listing it was given. */
const expectOffered = (
  offered: ReadonlyArray<ListedTool>,
  listing: AgentToolListing,
  removedByAdapter: ReadonlyArray<string> = [],
) => {
  const names = offered.map((tool) => tool.name).toSorted();
  const marked = offered
    .filter((tool) => tool._meta?.[ALWAYS_LOAD_META_KEY] === true)
    .map((tool) => tool.name)
    .toSorted();
  expect(marked, listing).toEqual(CORE);
  expect(names, listing).toEqual(
    listing === "core"
      ? CORE
      : threadTools.filter((name) => !removedByAdapter.includes(name)).toSorted(),
  );
};

const rpcResult = (text: string, id: number): unknown => {
  const lines = text.split(/\r?\n/).filter((line) => line.startsWith("data:"));
  const messages = (lines.length > 0 ? lines.map((line) => line.slice(5)) : [text]).map(
    (line) => JSON.parse(line) as { readonly id?: unknown; readonly result?: unknown },
  );
  return messages.find((message) => message.id === id)?.result;
};

/**
 * Codex, Claude Code, OpenCode and Cursor bring their own streamable HTTP MCP clients; this is
 * what any of them sends with the URL and headers its adapter configured.
 */
const listOverHttp = (url: string, headers: Readonly<Record<string, string>>) =>
  Effect.promise(async () => {
    let sessionId: string | null = null;
    let id = 0;
    const rpc = async (method: string, params: object) => {
      const requestId = ++id;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(sessionId === null
            ? {}
            : { "mcp-session-id": sessionId, "mcp-protocol-version": PROTOCOL }),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }),
      });
      sessionId = response.headers.get("mcp-session-id") ?? sessionId;
      return rpcResult(await response.text(), requestId);
    };
    await rpc("initialize", {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: "harness", version: "1" },
    });
    const tools: Array<ListedTool> = [];
    let cursor: unknown;
    do {
      const page = (await rpc("tools/list", cursor === undefined ? {} : { cursor })) as {
        readonly tools: ReadonlyArray<ListedTool>;
        readonly nextCursor?: unknown;
      };
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor !== undefined && cursor !== null);
    return tools;
  });

/** Serves /mcp under each listing, each on its own server, and hands the test its endpoint. */
const forEachListing = <R>(
  run: (endpoint: string, listing: AgentToolListing) => Effect.Effect<void, never, R>,
) =>
  Effect.forEach(
    ["core", "full"] as const,
    (listing) =>
      serveCatalogOverHttp({ thread }, listing).pipe(
        Effect.flatMap((http) => run(http.endpoint, listing)),
        Effect.scoped,
        Effect.provide(NodeHttpServer.layerTest),
      ),
    { discard: true },
  );

describe("what each harness is offered from GOAT's /mcp", () => {
  it.effect("Codex: its goat server config, less the tools it disables", () =>
    forEachListing((endpoint, listing) =>
      Effect.gen(function* () {
        const config = codexThreadRuntimeParams({ mcpSession: session(endpoint) }).config;
        const goat = config["mcp_servers.goat"] as {
          readonly url: string;
          readonly http_headers: Readonly<Record<string, string>>;
          readonly disabled_tools: ReadonlyArray<string>;
        };
        const listed = yield* listOverHttp(goat.url, goat.http_headers);
        const offered = listed.filter((tool) => !goat.disabled_tools.includes(tool.name));
        expectOffered(offered, listing, goat.disabled_tools);
      }),
    ),
  );

  it.effect("Codex code mode: the turn context names every tool the core listing keeps", () =>
    forEachListing((endpoint, listing) =>
      Effect.gen(function* () {
        if (listing !== "core") return;
        const goat = codexThreadRuntimeParams({ mcpSession: session(endpoint) }).config[
          "mcp_servers.goat"
        ] as { readonly url: string; readonly http_headers: Readonly<Record<string, string>> };
        const offered = yield* listOverHttp(goat.url, goat.http_headers);
        // Code mode drops tool_search from exec (openai/codex#32101), so a nested tool the
        // context does not name is one the model cannot find.
        const context = Object.values(
          buildCodexAdditionalContext({ model: "gpt-5", reasoningEffort: "high" }),
        )
          .map((entry) => entry.value)
          .join("\n");
        for (const tool of offered) expect(context).toContain("tools.mcp__goat__" + tool.name);
      }),
    ),
  );

  it.effect("Claude: its http goat server, with the core tools preapproved", () =>
    forEachListing((endpoint, listing) =>
      Effect.gen(function* () {
        for (const readOnlySandbox of [false, true]) {
          const overrides = claudeMcpQueryOverrides({
            mcpSession: session(endpoint),
            readOnlySandbox,
          });
          const goat = overrides.mcpServers?.goat;
          if (goat?.type !== "http") return yield* Effect.die("Claude's goat server is not http");
          expectOffered(yield* listOverHttp(goat.url, goat.headers ?? {}), listing);
          const allowed = overrides.allowedTools ?? [];
          // goat_describe never asks; goat_call asks or not by its target path.
          expect(
            allowed.includes("mcp__goat__goat_describe") || allowed.includes("mcp__goat__*"),
            "read-only: " + readOnlySandbox,
          ).toBe(true);
        }
      }),
    ),
  );

  it.effect("OpenCode: the remote goat entry both of its adapters add", () =>
    forEachListing((endpoint, listing) =>
      Effect.gen(function* () {
        const goat = goatRemoteMcpConfig(session(endpoint));
        expectOffered(yield* listOverHttp(goat.url, goat.headers), listing);
      }),
    ),
  );

  it.effect("Cursor: the http goat server it gives the SDK agent", () =>
    forEachListing((endpoint, listing) =>
      Effect.gen(function* () {
        const goat = cursorMcpServers(session(endpoint))?.goat;
        if (goat === undefined || !("url" in goat))
          return yield* Effect.die("Cursor's goat server is not http");
        expectOffered(yield* listOverHttp(goat.url, goat.headers ?? {}), listing);
      }),
    ),
  );

  it.effect("ACP: the stdio bridge and the MCP-over-ACP bridge both pass the listing through", () =>
    forEachListing((endpoint, listing) =>
      Effect.gen(function* () {
        const context = acpMcpContext(session(endpoint), { command: "goat" });
        const env = new Map(
          (context.servers[0]?.env ?? []).map((variable) => [variable.name, variable.value]),
        );
        expectOffered(
          yield* listThroughStdioBridge(
            env.get("GOAT_ACP_MCP_ENDPOINT") ?? "",
            env.get("GOAT_ACP_MCP_AUTHORIZATION") ?? "",
          ),
          listing,
        );

        const bridge = yield* makeAcpMcpOverAcpBridge({
          endpoint: context.endpoint ?? "",
          authorization: context.authorization ?? "",
          allocateConnectionId: Effect.succeed("connection"),
        });
        const { connectionId } = yield* bridge.connect({ serverId: "goat" });
        yield* bridge.message({
          connectionId,
          method: "initialize",
          params: {
            protocolVersion: PROTOCOL,
            capabilities: {},
            clientInfo: { name: "acp-agent", version: "1" },
          },
        });
        const listed = (yield* bridge.message({ connectionId, method: "tools/list" })) as {
          readonly tools: ReadonlyArray<ListedTool>;
        };
        expectOffered(listed.tools, listing);
        yield* bridge.dispose;
      }).pipe(Effect.orDie),
    ),
  );

  it.effect("Pi: its bridge declares what /mcp marks to load and defers the rest", () =>
    forEachListing((endpoint, listing) =>
      Effect.gen(function* () {
        const launch = buildPiRpcLaunch({
          launchArgs: [],
          environment: {},
          mcpSession: session(endpoint),
          extensionPath: "/fixture/pi-t3-extension.ts",
        });
        const bridge = yield* Effect.promise(() =>
          loadMcpBridge({ modern: true, toolSearchAvailable: true, server: { env: launch.env } }),
        );
        const names = (exposure?: string) =>
          bridge.tools
            .filter((tool) => exposure === undefined || tool.exposure === exposure)
            .map((tool) => tool.name.slice("mcp__goat__".length))
            .toSorted();
        expect(names(), listing).toEqual(listing === "core" ? CORE : threadTools.toSorted());
        // The marked tools are declared to the model; the rest wait for tool_search.
        expect(names("direct"), listing).toEqual(CORE);
      }),
    ),
  );
});

/** tools/list as an ACP agent sends it to "goat acp-mcp-bridge" over stdio. */
const listThroughStdioBridge = (endpoint: string, authorization: string) =>
  Effect.gen(function* () {
    const input = new NodeStream.PassThrough();
    const answers = new Map<number, (result: unknown) => void>();
    yield* runAcpMcpStdioBridge({
      endpoint,
      authorization,
      input,
      output: {
        write: (chunk: string) => {
          for (const line of chunk.split("\n").filter((text) => text.length > 0)) {
            const message = JSON.parse(line) as { readonly id?: number; readonly result?: unknown };
            if (message.id !== undefined) answers.get(message.id)?.(message.result);
          }
        },
      },
    }).pipe(Effect.forkScoped);
    const send = (id: number, method: string, params: object) =>
      Effect.gen(function* () {
        // Registered before the request is written, so an early answer is not missed.
        const result = new Promise<unknown>((resolve) => answers.set(id, resolve));
        input.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
        return yield* Effect.promise(() => result);
      });
    yield* send(1, "initialize", {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: "acp-agent", version: "1" },
    });
    const listed = (yield* send(2, "tools/list", {})) as {
      readonly tools: ReadonlyArray<ListedTool>;
    };
    input.end();
    return listed.tools;
  });
