import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import { ALWAYS_LOAD_META_KEY } from "@goat/contracts/agentSurface/listing";
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
/** The message of a refusal, which travels as an encoded OrchestratorMcpFailure. */
const refusalMessage = (result: { readonly content: ReadonlyArray<unknown> }) => {
  const [block] = result.content as ReadonlyArray<{ readonly text?: string }>;
  return (JSON.parse(block?.text ?? "{}") as { readonly message?: string }).message ?? "";
};

/** What a thread's model sees of the core listing: name, description and input schema. */
const CORE_LISTING_BUDGET_BYTES = 6 * 1024;

it.effect("lists only core tools in the core listing, each caller only those it can use", () =>
  Effect.gen(function* () {
    const http = yield* serveCatalogOverHttp(callers, "core");
    expect(names(yield* http.listTools("thread"))).toEqual(
      listed((entry) => "listing" in entry && entry.listing === "core"),
    );
    expect(names(yield* http.listTools("client"))).toEqual(["goat_call", "goat_describe"]);
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

it.effect(
  "keeps every tool callable by each of its names, refusing under the name it is listed by",
  () =>
    Effect.gen(function* () {
      const http = yield* serveCatalogOverHttp(callers, "core");
      for (const entry of entries) {
        const caller = entry.requires === "client" ? "client" : "thread";
        // The meta tools keep their short names; every other path also answers to goat_<path>.
        const canonical = entry.resource === "surface" ? [] : [canonicalToolName(entry)];
        // A refusal naming a legacy name would send the agent back to a name no longer listed.
        const refusal = `${listedToolName(entry)} does not take goat_probe`;
        for (const name of new Set([listedToolName(entry), ...canonical, ...entry.legacyNames])) {
          // An undeclared argument is refused before the handler, so nothing runs.
          const direct = yield* http.callTool(caller, name, { goat_probe: 1 });
          expect(textOf(direct), name).toContain(refusal);
          if (entry.resource === "surface") continue;
          const called = yield* http.callTool(caller, "goat_call", {
            path: name,
            args: { goat_probe: 1 },
          });
          expect(textOf(called), name).toContain(refusal);
        }
      }
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

it.effect(
  "refuses goat_call's argument wrapper on a direct call and says where its fields go",
  () =>
    Effect.gen(function* () {
      const http = yield* serveCatalogOverHttp(callers, "core");
      const refused = (name: string, args: object) =>
        http.callTool("thread", name, args).pipe(Effect.map(refusalMessage));
      for (const name of ["goat_provider_list", "orchestrator_capabilities"])
        for (const key of ["args", "arguments"])
          expect(yield* refused(name, { [key]: { search: "claude" } }), `${name} ${key}`).toBe(
            `goat_provider_list does not take ${key}, so nothing ran. It takes search. ` +
              `${key} wraps arguments only for goat_call {path: "provider.list", args: {...}}; ` +
              "call goat_provider_list with its fields at the top level instead.",
          );
      // Only an object wrapper by itself is goat_call's shape; anything else is a plain unknown field.
      for (const args of [{ args: "claude" }, { args: { search: "claude" }, bogus: 1 }])
        expect(yield* refused("goat_provider_list", args), JSON.stringify(args)).not.toContain(
          "goat_call",
        );
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
