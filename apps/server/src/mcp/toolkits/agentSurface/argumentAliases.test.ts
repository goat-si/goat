import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import { NodeHttpServer } from "@effect/platform-node";
import * as Effect from "effect/Effect";

import { serveCatalogOverHttp } from "../../agentSurface.testkit.ts";
import type { McpInvocationScope } from "../../McpInvocationContext.ts";

const thread: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment"),
  capabilities: new Set(["orchestration", "worktree", "pull-requests", "preview"] as const),
  issuedAt: 0,
  requestNamespace: "provider:thread",
  thread: {
    threadId: ThreadId.make("thread"),
    providerSessionId: "provider:thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
};
const serve = serveCatalogOverHttp({ thread });
const textOf = (result: { readonly content: ReadonlyArray<unknown> }) =>
  JSON.stringify(result.content);

it.effect("goat_describe takes name, tool, and resource with verb as its path", () =>
  Effect.gen(function* () {
    const http = yield* serve;
    const described = (args: object) =>
      http
        .callTool("thread", "goat_describe", args)
        .pipe(Effect.map((result) => result.structuredContent));
    const byPath = yield* described({ path: "thread.read" });
    expect(byPath).toMatchObject({ depth: "path", entry: { path: "thread.read" } });
    for (const args of [
      { name: "thread.read" },
      { name: "goat_thread_read" },
      { tool: "thread.read" },
      { resource: "thread", verb: "read" },
      // Two fields naming the same target, by different spellings, agree.
      { path: "thread.read", name: "goat_thread_read" },
    ])
      expect(yield* described(args), JSON.stringify(args)).toEqual(byPath);
    // A resource alone is a path too, as goat_describe { path: "thread" } is.
    expect(yield* described({ resource: "thread" })).toEqual(yield* described({ path: "thread" }));
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("goat_call takes MCP's {name, arguments}, tool, input, and resource with verb", () =>
  Effect.gen(function* () {
    const http = yield* serve;
    const call = (args: object) =>
      http.callTool("thread", "goat_call", args).pipe(Effect.map(textOf));
    // A refusal, a missing path and a recursive call: each alias must meet the same answer.
    for (const [path, args] of [
      ["thread.read", { goat_probe: 1 }],
      ["nope.missing", {}],
      ["surface.call", {}],
    ] as const) {
      const canonical = yield* call({ path, args });
      const [resource, verb] = path.split(".");
      for (const aliased of [
        { name: path, arguments: args },
        { tool: path, input: args },
        { path, input: args },
        { resource, verb, args },
      ])
        expect(yield* call(aliased), JSON.stringify(aliased)).toEqual(canonical);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("goat_call through an alias meets the direct call's refusal", () =>
  Effect.gen(function* () {
    const http = yield* serve;
    const direct = textOf(yield* http.callTool("thread", "goat_thread_read", { goat_probe: 1 }));
    expect(direct).toContain("does not take goat_probe");
    const aliased = textOf(
      yield* http.callTool("thread", "goat_call", {
        name: "goat_thread_read",
        arguments: { goat_probe: 1 },
      }),
    );
    expect(aliased).toContain("does not take goat_probe");
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("refuses two fields that name different targets, naming both, and unknown fields", () =>
  Effect.gen(function* () {
    const http = yield* serve;
    const refusal = (tool: string, args: object) =>
      http.callTool("thread", tool, args).pipe(Effect.map(textOf));
    for (const [tool, args, a, b] of [
      ["goat_call", { path: "thread.read", name: "thread.send" }, "path", "name"],
      ["goat_call", { name: "thread.read", resource: "thread", verb: "send" }, "name", "resource"],
      [
        "goat_call",
        { path: "thread.read", args: { threadId: "a" }, input: { threadId: "b" } },
        "args",
        "input",
      ],
      ["goat_describe", { name: "thread.read", tool: "thread.send" }, "name", "tool"],
    ] as const) {
      const text = yield* refusal(tool, args);
      expect(text, JSON.stringify(args)).toContain("invalid_request");
      expect(text).toContain(`got both ${a} and ${b}`);
    }
    expect(yield* refusal("goat_call", { name: "thread.read", bogus: 1 })).toContain(
      "does not take bogus",
    );
    expect(yield* refusal("goat_describe", { verb: "read" })).toContain("does not take verb");
    // The same args object written in another key order is one value, not a conflict.
    expect(
      yield* refusal("goat_call", {
        path: "thread.read",
        args: { goat_probe: 1, threadId: "a" },
        arguments: { threadId: "a", goat_probe: 1 },
      }),
    ).toContain("does not take goat_probe");
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);
