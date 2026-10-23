import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import { catalog, client, dependencies } from "../../agentSurface.testkit.ts";
import { McpInvocationContext, type McpInvocationScope } from "../../McpInvocationContext.ts";
import { surfaceVersionOf } from "./describe.ts";
import { searchEntries } from "./search.ts";

const entries = Object.values(agentSurfaceRegistry);
const agentSurfaceEntries = (resource: string) =>
  entries.filter((entry) => entry.resource === resource);
const registered = catalog.pipe(
  Layer.provide(dependencies),
  Layer.provideMerge(McpServer.McpServer.layer),
);

const scope = (caller: "thread" | "client"): McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: caller,
  thread:
    caller === "thread"
      ? {
          threadId: ThreadId.make("thread"),
          providerSessionId: "provider:thread",
          providerInstanceId: ProviderInstanceId.make("codex"),
        }
      : undefined,
  client:
    caller === "thread"
      ? undefined
      : { sessionId: "session", label: "Agent", access: "full-access" },
  capabilities: new Set(["orchestration", "worktree", "pull-requests", "preview"]),
  issuedAt: 0,
});

interface Found {
  readonly path: string;
  readonly match: string;
  readonly available?: { readonly now: boolean };
}
interface Search {
  readonly depth: string;
  readonly mode: string;
  readonly entries: ReadonlyArray<Found>;
  readonly total: number;
  readonly returned: number;
  readonly truncated: boolean;
  readonly nextCursor?: string;
  readonly coverage: { readonly unavailableToCaller: number; readonly notServed: number };
  readonly nearest?: ReadonlyArray<string>;
}

const describeAs = (caller: "thread" | "client", args: object) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server.callTool({ name: "goat_describe", arguments: args });
    return result;
  }).pipe(
    Effect.provideService(McpInvocationContext, scope(caller)),
    Effect.provideService(McpSchema.McpServerClient, client),
  );
const searchAs = (caller: "thread" | "client", args: object) =>
  describeAs(caller, args).pipe(
    Effect.map((result) => {
      expect(result.isError).not.toBe(true);
      return result.structuredContent as unknown as Search;
    }),
  );

describe("goat_describe search", () => {
  it("finds a path by words only its guide holds", () => {
    const send = agentSurfaceRegistry["thread.send"];
    const withGuide = { ...send, guide: "Zebra crossings need a pedestrian signal." };
    expect(
      searchEntries([withGuide], "zebra pedestrian").matches.map(({ entry }) => entry.path),
    ).toEqual(["thread.send"]);
    expect(searchEntries([send], "zebra pedestrian").matches).toEqual([]);
  });

  it("puts the path an agent means in the top five for natural phrasing (#962)", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["reply to pending request", "pending_request.respond"],
      ["babysit pr checks", "pull_request.watch"],
      ["pr merge watch", "pull_request.watch"],
      ["which host has room", "host.status"],
      ["check host load", "host.status"],
      ["watch PR", "pull_request.watch"],
    ];
    for (const [query, path] of cases) {
      const top = searchEntries(entries, query)
        .matches.slice(0, 5)
        .map(({ entry }) => entry.path);
      expect(top, query).toContain(path);
    }
  });

  it("reports the words each partial match lacks", () => {
    const outcome = searchEntries(entries, "reply to pending request");
    expect(outcome.mode).toBe("partial");
    expect(outcome.ignoredWords).toEqual(["to"]);
    const respond = outcome.matches.find(({ entry }) => entry.path === "pending_request.respond");
    expect(respond).toMatchObject({
      match: "partial",
      matchedWords: ["pending", "request"],
      unmatchedWords: ["reply"],
    });
  });

  it.effect("puts an exactly named tool first, by any of its names", () =>
    Effect.gen(function* () {
      for (const name of ["delegate_task", "goat_task_create", "task.create"]) {
        const found = yield* searchAs("thread", { query: name });
        expect(found.entries[0], name).toMatchObject({ path: "task.create", match: "exact" });
      }
    }).pipe(Effect.provide(registered)),
  );

  it.effect(
    "pages a search without losing or repeating a path, truncated until the last page",
    () =>
      Effect.gen(function* () {
        const seen: Array<string> = [];
        let page = yield* searchAs("thread", { query: "thread", limit: 7, detail: "names" });
        const total = page.total;
        expect(total).toBeGreaterThan(7);
        for (;;) {
          seen.push(...page.entries.map(({ path }) => path));
          expect(page.returned).toBe(page.entries.length);
          expect(page.truncated).toBe(seen.length < total);
          if (page.nextCursor === undefined) break;
          page = yield* searchAs("thread", {
            query: "thread",
            limit: 7,
            detail: "names",
            cursor: page.nextCursor,
          });
        }
        expect(seen).toHaveLength(total);
        expect(new Set(seen).size).toBe(total);
      }).pipe(Effect.provide(registered)),
  );

  it.effect("refuses a cursor from another search", () =>
    Effect.gen(function* () {
      const first = yield* searchAs("thread", { query: "thread", limit: 3 });
      const other = yield* describeAs("thread", { query: "host", cursor: first.nextCursor });
      expect(other.isError).toBe(true);
    }).pipe(Effect.provide(registered)),
  );

  it.effect("answers a query nothing matches with nearest paths, never as absence", () =>
    Effect.gen(function* () {
      const none = yield* searchAs("thread", { query: "zqxj vblk" });
      expect(none).toMatchObject({ mode: "none", total: 0, returned: 0, truncated: false });
      expect(none.nearest).toHaveLength(3);
      const unknown = yield* searchAs("thread", { path: "thread.teleport" });
      expect(unknown).toMatchObject({ depth: "search", mode: "partial" });
      expect(unknown.entries.every(({ path }) => path.startsWith("thread."))).toBe(true);
    }).pipe(Effect.provide(registered)),
  );

  it.effect("serves a guide for one path and leaves it out of search results", () =>
    Effect.gen(function* () {
      const full = yield* describeAs("thread", { path: "goat_describe" });
      const entry = (full.structuredContent as { entry: { guide?: string } }).entry;
      expect(entry.guide).toBe(agentSurfaceRegistry["surface.describe"].guide);
      const found = yield* searchAs("thread", { query: "goat_describe" });
      expect(found.entries[0]).not.toHaveProperty("guide");
    }).pipe(Effect.provide(registered)),
  );

  it("matches singular and plural forms and ranks a resource's initials above a prefix", () => {
    const top = (query: string) =>
      searchEntries(entries, query)
        .matches.slice(0, 8)
        .map(({ entry }) => entry.path);
    expect(searchEntries(agentSurfaceEntries("host"), "statuses").matches[0]?.entry.path).toBe(
      "host.status",
    );
    // Both resources have the initials; a name that only starts with "pr" ranks after them.
    expect(top("pr").every((path) => /^(pull|pending)_request\./u.test(path))).toBe(true);
  });

  it.effect("calls a search that named a path exact, even with nothing else matching", () =>
    Effect.gen(function* () {
      const found = yield* searchAs("thread", { path: "workflow", query: "workflow.stop" });
      expect(found).toMatchObject({ mode: "exact", total: 1 });
    }).pipe(Effect.provide(registered)),
  );

  it.effect("refuses a cursor past the end of its search", () =>
    Effect.gen(function* () {
      const first = (yield* searchAs("thread", { query: "thread", limit: 3 })) as Search & {
        readonly surfaceVersion: string;
      };
      const pastEnd = Buffer.from(
        JSON.stringify({ version: first.surfaceVersion, query: "thread", path: null, offset: 1e5 }),
      ).toString("base64url");
      const refused = yield* describeAs("thread", { query: "thread", cursor: pastEnd });
      expect(refused.isError).toBe(true);
    }).pipe(Effect.provide(registered)),
  );

  it.effect("continues a search that an unknown path started, with its cursor", () =>
    Effect.gen(function* () {
      const first = yield* searchAs("thread", { path: "thread.teleport", limit: 1 });
      expect(first.nextCursor).toBeDefined();
      const next = yield* searchAs("thread", {
        path: "thread.teleport",
        limit: 1,
        cursor: first.nextCursor,
      });
      expect(next.entries[0]?.path).not.toBe(first.entries[0]?.path);
    }).pipe(Effect.provide(registered)),
  );

  it.effect("describes one path at the detail asked for", () =>
    Effect.gen(function* () {
      const named = yield* describeAs("thread", { path: "goat_describe", detail: "names" });
      expect((named.structuredContent as { entry: object }).entry).toEqual({
        path: "surface.describe",
        name: "goat_describe",
        summary: agentSurfaceRegistry["surface.describe"].summary,
      });
    }).pipe(Effect.provide(registered)),
  );

  it.effect("refuses a query too long to be a search", () =>
    Effect.gen(function* () {
      const refused = yield* Effect.flip(describeAs("thread", { query: "word ".repeat(200) }));
      expect(refused._tag).toBe("InvalidParams");
    }).pipe(Effect.provide(registered)),
  );

  it("matches -y words and their -ies plurals, and -ie words and theirs", () => {
    for (const plural of ["queries", "policies", "activities"])
      expect(searchEntries(entries, plural).matches.length, plural).toBeGreaterThan(0);
    const send = agentSurfaceRegistry["thread.send"];
    const cookie = { ...send, summary: "Send a cookie" };
    expect(searchEntries([cookie], "cookies").matches).toHaveLength(1);
  });

  it("changes the surface version when a summary or a legacy name changes", () => {
    const version = surfaceVersionOf(entries);
    // In place, so only the field changes and never the order.
    const changed = (change: object) =>
      surfaceVersionOf(
        entries.map((entry) => (entry.path === "thread.send" ? { ...entry, ...change } : entry)),
      );
    expect(changed({})).toBe(version);
    expect(changed({ summary: "Other words" })).not.toBe(version);
    expect(changed({ legacyNames: ["send"] })).not.toBe(version);
  });

  it.effect("holds a path that is searched to the query's length", () =>
    Effect.gen(function* () {
      const refused = yield* Effect.flip(describeAs("thread", { path: "x".repeat(600) }));
      expect(refused._tag).toBe("InvalidParams");
    }).pipe(Effect.provide(registered)),
  );

  it.effect("returns matches the caller cannot use, flagged and counted", () =>
    Effect.gen(function* () {
      const found = yield* searchAs("client", { query: "html render" });
      expect(found.entries.find(({ path }) => path === "html.render")?.available).toMatchObject({
        now: false,
      });
      expect(found.coverage.unavailableToCaller).toBeGreaterThan(0);
    }).pipe(Effect.provide(registered)),
  );
});
