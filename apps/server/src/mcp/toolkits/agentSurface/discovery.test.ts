import { NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  MemoryReadInput,
  MemorySearchInput,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import { type AgentSurfaceEntry, agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import type { AgentSurfaceResult } from "@goat/contracts/agentSurface/envelope";
import { listedToolName, resolveAgentSurfaceEntry } from "@goat/contracts/agentSurface/resolve";
import { toSignature } from "@goat/contracts/agentSurface/signature";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { type McpSchema, Tool } from "effect/ai";

import { type ListedTool, serveCatalogOverHttp, toolkits } from "../../agentSurface.testkit.ts";
import type { McpInvocationScope } from "../../McpInvocationContext.ts";

const thread: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "provider:thread",
  thread: {
    threadId: ThreadId.make("thread"),
    providerSessionId: "provider:thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration", "worktree", "pull-requests", "preview"]),
  issuedAt: 0,
};

const serve = serveCatalogOverHttp(
  {
    thread,
    client: {
      ...thread,
      thread: undefined,
      client: { sessionId: "discovery-client", label: "Discovery", access: "read-only" },
      grantedScopes: ["diagnostics:read", "filesystem:read"],
      reauthorize: () => Effect.void,
    },
  },
  "full",
);

const schemaOf = (tools: ReadonlyArray<ListedTool>, path: string) => {
  const entry = resolveAgentSurfaceEntry(path);
  return tools.find((tool) => entry !== undefined && tool.name === listedToolName(entry))
    ?.inputSchema;
};

/** The keys a listed signature names, dotted for a nested one, as toSignature's pick takes them. */
const keysOf = (line: string) => {
  const keys: Array<string> = [];
  const open: Array<string> = [];
  let last = "";
  for (const [token, key] of line.matchAll(/:(\w+)\??|[{}]/gu)) {
    if (token === "{") open.push(last);
    else if (token === "}") open.pop();
    else if (key !== undefined) {
      last = key;
      keys.push([...open, key].join("."));
    }
  }
  return keys;
};

const structured = <A>(result: McpSchema.CallToolResult) => {
  expect(result.isError).not.toBe(true);
  return result.structuredContent as A;
};

it.effect("lists goat_call's signatures as the served schemas declare those keys", () =>
  Effect.gen(function* () {
    const http = yield* serve;
    const tools = yield* http.listTools("thread");
    const description = tools.find((tool) => tool.name === "goat_call")?.description ?? "";
    const lines = description.split("\n").filter((line) => line.startsWith("("));
    expect(lines.length).toBeGreaterThanOrEqual(20);
    for (const line of lines) {
      const path = /^\(([\w.]+)/u.exec(line)?.[1] ?? "";
      expect(resolveAgentSurfaceEntry(path)?.path, line).toBe(path);
      // Every required key appears, every key shown exists, and ... marks the keys left out.
      expect(line).toBe(toSignature(path, schemaOf(tools, path), { pick: keysOf(line) }));
    }
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

it("renders a signature for every schema shape tools declare", () => {
  const optional = (schema: object) => ({ anyOf: [schema, { type: "null" }] });
  const schema = {
    type: "object",
    properties: {
      id: { type: "string" },
      mode: optional({ type: "string", enum: ["a", "b"] }),
      tags: optional({ type: "array", items: { type: "string" } }),
      target: {
        type: "object",
        properties: { kind: { type: "string" }, note: { type: "string" } },
        required: ["kind"],
      },
      options: { type: "object", additionalProperties: { type: "string" } },
    },
    required: ["id", "target"],
  };
  expect(toSignature("x.full", schema)).toBe(
    "(x.full :id :mode?=a|b :tags?[] :target{:kind :note?} :options?{...})",
  );
  expect(toSignature("x.list", schema, { depth: 0 })).toBe(
    "(x.list :id :mode?=a|b :tags?[] :target{} :options?{})",
  );
  // A picked object that names none of its fields still shows the ones it requires.
  expect(toSignature("x.pick", schema, { pick: ["mode"] })).toBe(
    "(x.pick :id :mode?=a|b :target{:kind ...} ...)",
  );
  // Keys that only branches declare are optional; extra keys a record takes show as ...
  expect(
    toSignature("x.branches", {
      type: "object",
      anyOf: [
        { type: "object", properties: { a: { type: "boolean" } }, required: ["a"] },
        { type: "object", properties: { b: { type: "boolean" } }, required: ["b"] },
      ],
    }),
  ).toBe("(x.branches :a? :b?)");
  // Alternatives that overlap keep a key required by all of them, and every value either allows.
  const upload = (type: string, mimeType: object, required: ReadonlyArray<string>) => ({
    type: "object",
    properties: { type: { type: "string", enum: [type] }, name: { type: "string" }, mimeType },
    required,
  });
  expect(
    toSignature("x.union", {
      type: "object",
      properties: {
        upload: {
          anyOf: [
            upload("image", { type: "string", enum: ["image/png"] }, ["name", "mimeType"]),
            upload("file", { type: "string" }, ["type", "name", "mimeType"]),
          ],
        },
      },
      required: ["upload"],
    }),
  ).toBe("(x.union :upload{:type?=image|file :name :mimeType})");
  // Alternatives nested inside alternatives read as if they were listed flat.
  const variant = (key: string) => ({
    type: "object",
    properties: { shared: { type: "string" }, [key]: { type: "string" } },
    required: ["shared", key],
  });
  const flat = { anyOf: [variant("a"), variant("b"), variant("c")] };
  const nested = { anyOf: [{ anyOf: [variant("a"), variant("b")] }, variant("c")] };
  for (const payload of [flat, nested])
    expect(
      toSignature("x.nested", { type: "object", properties: { payload }, required: ["payload"] }),
    ).toBe("(x.nested :payload{:shared :a? :b? :c?})");
  expect(toSignature("x.record", { type: "object", additionalProperties: {} })).toBe(
    "(x.record ...)",
  );
  expect(toSignature("x.none", { type: "object", additionalProperties: false })).toBe("(x.none)");
});

interface Described {
  readonly path: string;
  readonly signature?: string;
  readonly inputSchema?: unknown;
}

it.effect("goat_describe answers several paths at once and shows signatures in lists", () =>
  Effect.gen(function* () {
    const http = yield* serve;
    const tools = yield* http.listTools("thread");
    const describe = (args: object) => http.callTool("thread", "goat_describe", args);

    const batch = structured<{
      depth: string;
      entries: ReadonlyArray<Described>;
      missing: ReadonlyArray<{ path: string; nearest: ReadonlyArray<string> }>;
    }>(
      yield* describe({
        paths: ["thread.read", "goat_task_create", "thread.teleport", "thread.read"],
      }),
    );
    expect(batch.depth).toBe("paths");
    expect(batch.entries.map((entry) => entry.path)).toEqual(["thread.read", "task.create"]);
    expect(batch.entries[0]?.inputSchema).toEqual(schemaOf(tools, "thread.read"));
    expect(batch.entries[1]?.signature).toBe(
      toSignature("task.create", schemaOf(tools, "task.create")),
    );
    expect(batch.missing.map((entry) => entry.path)).toEqual(["thread.teleport"]);
    expect(batch.missing[0]?.nearest.length).toBeGreaterThan(0);
    expect((yield* describe({ paths: ["thread.read"], query: "read" })).isError).toBe(true);

    const search = structured<{ entries: ReadonlyArray<Described> }>(
      yield* describe({ query: "read a thread" }),
    );
    const resource = structured<{ entries: ReadonlyArray<Described> }>(
      yield* describe({ path: "task" }),
    );
    for (const entry of [...search.entries, ...resource.entries])
      expect(entry.signature, entry.path).toBe(
        toSignature(entry.path, schemaOf(tools, entry.path), { depth: 0 }),
      );
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("goat_call returns the path's signature with arguments it refuses before running", () =>
  Effect.gen(function* () {
    const http = yield* serve;
    const tools = yield* http.listTools("thread");
    const call = (args: object) =>
      http
        .callTool("thread", "goat_call", { path: "thread.read", args })
        .pipe(Effect.map((result) => structured<AgentSurfaceResult>(result)));
    const expected = {
      status: "error",
      error: {
        code: "invalid_request",
        details: { expectedSignature: toSignature("thread.read", schemaOf(tools, "thread.read")) },
      },
    };
    // An undeclared key, and a declared one whose value does not decode.
    expect(yield* call({ threadId: "t1", newestFirst: true })).toMatchObject(expected);
    expect(yield* call({ threadId: 5 })).toMatchObject(expected);

    // An accepted alias is no undeclared key, so the handler's own refusal keeps its details.
    const domain = structured<AgentSurfaceResult>(
      yield* http.callTool("thread", "goat_call", {
        path: "surface.describe",
        args: { name: "thread.read", query: "read", detail: "full" },
      }),
    );
    expect(domain).toMatchObject({ status: "error", error: { code: "invalid_request" } });
    expect(domain.status === "error" && domain.error.details).toBeFalsy();
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

const notesOf = (entry: AgentSurfaceEntry) => entry.parameters;

// Dynamic tools carry JSON Schema; their handlers decode with these contract schemas.
const dynamicInputs: Readonly<Record<string, Schema.Codec<unknown, unknown>>> = {
  "memory.search": MemorySearchInput,
  "memory.read": MemoryReadInput,
};

const describedProperty = (property: unknown) => {
  if (typeof property !== "object" || property === null) return false;
  const { description, anyOf } = property as { description?: unknown; anyOf?: unknown };
  return (
    description !== undefined ||
    (Array.isArray(anyOf) &&
      anyOf.some(
        (branch) => typeof branch === "object" && branch !== null && "description" in branch,
      ))
  );
};

it.effect(
  "describes every argument of the paths goat_call lists and serves examples their tools decode",
  () =>
    Effect.gen(function* () {
      const http = yield* serve;
      const tools = [...(yield* http.listTools("thread")), ...(yield* http.listTools("client"))];
      const listed = (tools.find((tool) => tool.name === "goat_call")?.description ?? "")
        .split("\n")
        .flatMap((line) => /^\(([\w.]+)/u.exec(line)?.[1] ?? []);
      const documented = Object.values(agentSurfaceRegistry).filter(
        (entry) => listed.includes(entry.path) || entry.examples.length > 0,
      );
      expect(documented.length).toBeGreaterThanOrEqual(listed.length);
      for (const entry of documented) {
        const schema = schemaOf(tools, entry.path) as
          | { properties?: Record<string, unknown> }
          | undefined;
        const undescribed = Object.entries(schema?.properties ?? {})
          .filter(([, property]) => !describedProperty(property))
          .map(([name]) => name);
        expect(undescribed, entry.path).toEqual([]);
        expect(entry.examples.length, entry.path).toBeGreaterThan(0);

        // A note the schema already covers would never be served.
        for (const [key, note] of Object.entries(notesOf(entry) ?? {})) {
          const property = key.split(".").reduce<unknown>((at, name) => {
            const object = at as { properties?: Record<string, unknown>; anyOf?: unknown[] };
            const holder =
              object?.properties === undefined
                ? object?.anyOf?.find((branch) => (branch as { properties?: unknown })?.properties)
                : object;
            return (holder as { properties?: Record<string, unknown> } | undefined)?.properties?.[
              name
            ];
          }, schema);
          expect(
            (property as { description?: string } | undefined)?.description,
            `${entry.path} ${key}`,
          ).toBe(note);
        }

        const tool = (toolkits as Record<string, { tools: Record<string, Tool.Any> }>)[
          entry.toolkit
        ]?.tools[entry.name];
        // Tool inputs need no services to decode.
        const parameters = (
          tool !== undefined && Tool.isDynamic(tool)
            ? dynamicInputs[entry.path]
            : tool?.parametersSchema
        ) as Schema.Codec<unknown, unknown> | undefined;
        expect(parameters, entry.path).toBeDefined();
        for (const example of entry.examples)
          expect(
            Schema.decodeExit(parameters ?? Schema.Never)(example.args)._tag,
            `${entry.path}: ${example.title}`,
          ).toBe("Success");
      }

      const described = structured<{
        entries: ReadonlyArray<{ path: string; examples?: unknown }>;
      }>(
        yield* http.callTool("thread", "goat_describe", { paths: ["thread.read", "task.create"] }),
      );
      for (const served of described.entries)
        expect(served.examples, served.path).toEqual(
          resolveAgentSurfaceEntry(served.path)?.examples,
        );
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);
