import { NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import {
  AGENT_TOOL_LISTING_HEADER,
  ALWAYS_LOAD_META_KEY,
  type AgentToolListing,
} from "@goat/contracts/agentSurface/listing";
import * as Effect from "effect/Effect";

import { type ListedTool, serveCatalogOverHttp } from "../../agentSurface.testkit.ts";
import type { McpInvocationScope } from "../../McpInvocationContext.ts";

const base: Pick<McpInvocationScope, "environmentId" | "capabilities" | "issuedAt"> = {
  environmentId: EnvironmentId.make("environment"),
  capabilities: new Set(["orchestration", "worktree", "pull-requests", "preview"]),
  issuedAt: 0,
};
const callers: Record<"thread" | "client", McpInvocationScope> = {
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
    requestNamespace: "client:session",
    thread: undefined,
    client: { sessionId: "session", label: "Agent", access: "full-access" },
  },
};

/** Whether goat_eval is listed, and whether it is marked to load up front. */
const evalIn = (tools: ReadonlyArray<ListedTool>) => {
  const tool = tools.find((candidate) => candidate.name === "goat_eval");
  return tool === undefined
    ? "unlisted"
    : tool._meta?.[ALWAYS_LOAD_META_KEY] === true
      ? "resident"
      : "listed";
};

// Each listing gets its own server: two servers in one test layer would share one address.
const listedAs = (
  listing: AgentToolListing,
  headers?: Readonly<Record<string, Readonly<Record<string, string>>>>,
) =>
  Effect.gen(function* () {
    const http = yield* serveCatalogOverHttp(callers, listing, headers);
    return {
      thread: yield* http.listTools("thread"),
      client: yield* http.listTools("client"),
    };
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest));

it.effect("lists goat_eval up front only where agents get the opt-in core_eval listing", () =>
  Effect.gen(function* () {
    const expected: Record<AgentToolListing, { thread: string; client: string }> = {
      core: { thread: "unlisted", client: "listed" },
      full: { thread: "listed", client: "listed" },
      // A client keeps the full listing; the marker tells it which tools agents load up front.
      core_eval: { thread: "resident", client: "resident" },
    };
    for (const listing of ["core", "full", "core_eval"] as const) {
      const listed = yield* listedAs(listing);
      expect({ thread: evalIn(listed.thread), client: evalIn(listed.client) }, listing).toEqual(
        expected[listing],
      );
    }
    // An outside client can ask for the opt-in listing itself, as for core.
    const asking = yield* listedAs("core", {
      client: { [AGENT_TOOL_LISTING_HEADER]: "core_eval" },
    });
    expect(asking.client.map((tool) => tool.name).toSorted()).toEqual([
      "goat_call",
      "goat_describe",
      "goat_eval",
    ]);
  }),
);

it.effect("goat_eval plans a program over goat_call's paths without running it", () =>
  Effect.gen(function* () {
    const http = yield* serveCatalogOverHttp(callers, "core");
    const result = yield* http.callTool("thread", "goat_eval", {
      program: '(pick (thread.read :threadId "t1") :title)',
      dryRun: true,
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      status: "ok",
      value: { plan: { calls: [{ path: "thread.read", effect: "read" }] } },
    });
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);
