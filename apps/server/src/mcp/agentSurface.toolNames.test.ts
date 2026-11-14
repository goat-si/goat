import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpServer } from "effect/ai";

import * as Sqlite from "../persistence/Sqlite.ts";
import { catalog, dependencies } from "./agentSurface.testkit.ts";

const registered = catalog.pipe(
  Layer.provide(dependencies),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(McpServer.McpServer.layer),
);

describe("GOAT's MCP tool names", () => {
  it.effect(
    "contract: every tool GOAT serves keeps a function name OpenAI-compatible endpoints accept under both of GOAT's Codex server names",
    () =>
      Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        // Codex calls a tool mcp__<server>__<tool>; GOAT registers "goat" and "goat-direct"
        // (CodexAdapterV2). This pins GOAT's own names, not what every provider accepts.
        const names = ["goat", "goat-direct"].flatMap((name) =>
          server.tools.map(({ tool }) => `mcp__${name}__${tool.name}`),
        );
        expect(names.length).toBeGreaterThan(0);
        expect(names.filter((name) => !/^[a-zA-Z0-9_-]{1,64}$/.test(name))).toEqual([]);
      }).pipe(Effect.provide(registered)),
  );
});
