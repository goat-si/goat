import { NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import type { AgentSurfaceResult } from "@goat/contracts/agentSurface/envelope";
import { listedToolName, resolveAgentSurfaceEntry } from "@goat/contracts/agentSurface/resolve";
import { toSignature } from "@goat/contracts/agentSurface/signature";
import * as Effect from "effect/Effect";
import type { McpSchema } from "effect/ai";

import { type ListedTool, serveCatalogOverHttp } from "../../agentSurface.testkit.ts";
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

const serve = serveCatalogOverHttp({ thread }, "full");

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
    expect(yield* call({ threadId: "t1", tail: 5 })).toMatchObject(expected);
    expect(yield* call({ threadId: 5 })).toMatchObject(expected);
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);
