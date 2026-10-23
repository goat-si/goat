import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import {
  AGENT_TOOL_LISTING_META_KEY,
  ALWAYS_LOAD_META_KEY,
} from "@goat/contracts/agentSurface/listing";
import { canonicalToolName, listedToolName } from "@goat/contracts/agentSurface/resolve";
import { NodeHttpServer } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { HttpBody } from "effect/http";

import { type ListedTool, serveCatalogOverHttp } from "./agentSurface.testkit.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { filterToolsListBody } from "./toolListing.ts";

const entries = Object.values(agentSurfaceRegistry);
const base = {
  environmentId: EnvironmentId.make("environment"),
  capabilities: new Set(["orchestration", "worktree", "pull-requests", "preview"] as const),
  issuedAt: 0,
};
const callers: Readonly<Record<"thread" | "client" | "readOnly", McpInvocationScope>> = {
  thread: {
    ...base,
    requestNamespace: "provider:thread",
    thread: {
      threadId: ThreadId.make("thread"),
      providerSessionId: "provider:thread",
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
  },
  client: {
    ...base,
    requestNamespace: "client:full",
    thread: undefined,
    client: { sessionId: "client:full", label: "full", access: "full-access" },
  },
  readOnly: {
    ...base,
    readOnly: true,
    requestNamespace: "client:read-only",
    thread: undefined,
    client: { sessionId: "client:read-only", label: "read-only", access: "read-only" },
  },
};

const names = (tools: ReadonlyArray<ListedTool>) => tools.map((tool) => tool.name).sort();
const listed = (filter: (entry: (typeof entries)[number]) => boolean) =>
  entries.filter(filter).map(listedToolName).sort();
const textOf = (result: { readonly content: ReadonlyArray<unknown> }) =>
  JSON.stringify(result.content);

/** What a thread's model sees of the core listing: name, description and input schema. */
const CORE_LISTING_BUDGET_BYTES = 6 * 1024;

it.effect(
  "lists threads only the core tools, and keeps for clients the launch arguments another host's dispatch reads",
  () =>
    Effect.gen(function* () {
      const http = yield* serveCatalogOverHttp(callers, "core");
      expect(names(yield* http.listTools("thread"))).toEqual(
        listed((entry) => "listing" in entry && entry.listing === "core"),
      );
      const launch = (yield* http.listTools("client")).find(
        (tool) => tool.name === "goat_thread_launch",
      );
      const properties = (launch?.inputSchema as { readonly properties?: object } | undefined)
        ?.properties;
      expect(Object.keys(properties ?? {})).toEqual(
        expect.arrayContaining(["memoryGrantCeiling", "report", "standingInstructions"]),
      );
      // A client that keeps the full listing still learns which listing agents get.
      expect((yield* http.listResultMeta("client"))?.[AGENT_TOOL_LISTING_META_KEY]).toBe("core");
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

it.effect(
  "keeps every tool callable by each of its names when the core listing leaves it out",
  () =>
    Effect.gen(function* () {
      const http = yield* serveCatalogOverHttp(callers, "core");
      for (const entry of entries) {
        const caller = entry.requires === "client" ? "client" : "thread";
        // The meta tools keep their short names; every other path also answers to goat_<path>.
        const canonical = entry.resource === "surface" ? [] : [canonicalToolName(entry)];
        for (const name of new Set([listedToolName(entry), ...canonical, ...entry.legacyNames])) {
          // An undeclared argument is refused before the handler, so nothing runs.
          const direct = yield* http.callTool(caller, name, { goat_probe: 1 });
          expect(textOf(direct), name).toContain("does not take goat_probe");
          if (entry.resource === "surface") continue;
          const called = yield* http.callTool(caller, "goat_call", {
            path: name,
            args: { goat_probe: 1 },
          });
          expect(textOf(called), name).toContain("does not take goat_probe");
        }
      }
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("lists every tool a caller can use in the full listing and hides the rest", () =>
  Effect.gen(function* () {
    const http = yield* serveCatalogOverHttp(callers, "full");
    expect(names(yield* http.listTools("thread"))).toEqual(
      listed((entry) => entry.requires !== "client"),
    );
    expect(names(yield* http.listTools("client"))).toEqual(
      listed((entry) => entry.requires !== "thread"),
    );
    expect(names(yield* http.listTools("readOnly"))).toEqual(
      listed(
        (entry) =>
          entry.requires !== "thread" && (entry.effect === "read" || entry.resource === "surface"),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("marks core tools to load up front in both listings, and no other tool", () =>
  Effect.gen(function* () {
    for (const listing of ["core", "full"] as const) {
      const http = yield* serveCatalogOverHttp(callers, listing);
      const marked = (yield* http.listTools("thread"))
        .filter((tool) => tool._meta?.[ALWAYS_LOAD_META_KEY] === true)
        .map((tool) => tool.name)
        .sort();
      expect(marked, listing).toEqual(
        listed((entry) => "listing" in entry && entry.listing === "core"),
      );
    }
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("keeps the core listing a thread's model sees within its byte budget", () =>
  Effect.gen(function* () {
    const http = yield* serveCatalogOverHttp(callers, "core");
    const seen = (yield* http.listTools("thread")).map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    }));
    expect(Buffer.byteLength(JSON.stringify(seen))).toBeLessThanOrEqual(CORE_LISTING_BUDGET_BYTES);
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("filters a tools/list whose method JSON spells with an escaped slash", () =>
  Effect.gen(function* () {
    const http = yield* serveCatalogOverHttp(callers, "core");
    const escaped = yield* http.listTools("thread", (body) =>
      body.replace('"tools/list"', '"tools\\/list"'),
    );
    expect(names(escaped)).toEqual(
      listed((entry) => "listing" in entry && entry.listing === "core"),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("filters a tools/list answer sent as SSE, buffered or streamed", () =>
  Effect.gen(function* () {
    const tools = entries.map((entry) => ({ name: listedToolName(entry) }));
    const event = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools } })}\n\n`;
    for (const body of [
      HttpBody.text(event, "text/event-stream"),
      HttpBody.stream(Stream.make(new TextEncoder().encode(event)), "text/event-stream"),
    ]) {
      const filtered = yield* filterToolsListBody(body, callers.thread, "core");
      const text = filtered._tag === "Uint8Array" ? new TextDecoder().decode(filtered.body) : "";
      const data = text.split("\n").find((line) => line.startsWith("data:")) ?? "";
      const result = JSON.parse(data.slice(5)) as { result: { tools: ReadonlyArray<ListedTool> } };
      expect(names(result.result.tools), body._tag).toEqual(["goat_call", "goat_describe"]);
    }
  }),
);

it.effect("filters a tools/list whose method JSON spells with unicode escapes", () =>
  Effect.gen(function* () {
    const http = yield* serveCatalogOverHttp(callers, "core");
    const escaped = yield* http.listTools("thread", (body) =>
      body.replace('"tools/list"', '"to\\u006fls\\u002flist"'),
    );
    expect(names(escaped)).toEqual(
      listed((entry) => "listing" in entry && entry.listing === "core"),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);
