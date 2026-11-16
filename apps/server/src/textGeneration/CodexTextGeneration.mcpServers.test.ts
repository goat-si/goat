import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";

import {
  DEFAULT_TEST_MODEL_SELECTION,
  layerCodexTextGenerationTest,
  withFakeCodexEnv,
} from "./codexTextGenerationFake.testkit.ts";

it.layer(layerCodexTextGenerationTest)("Codex text generation MCP servers", (it) => {
  it.effect("turns off an MCP server that launch args define without dropping its transport", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ title: "Remove default shapes" }),
        launchArgs: `-c 'mcp_servers.goat.url="http://127.0.0.1:1/mcp"' -c 'mcp_servers.goat.enabled=true'`,
        mcpServers: [{ name: "goat", enabled: true }],
        requireMcpServersOff: ["goat"],
        requireArg:
          "--config features.apps=false --config mcp_servers.goat.enabled=false --ephemeral",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const result = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Remove default shapes from characters",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });
          expect(result.title).toBe("Remove default shapes");
        }),
    ),
  );

  it.effect("keeps MCP servers off when launch args set their own mcp_servers table", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ title: "Remove default shapes" }),
        launchArgs: `-c 'mcp_servers={"my.server"={command="echo",enabled=true}}'`,
        mcpServers: [
          { name: "my.server", enabled: true },
          { name: "my server", enabled: true },
        ],
        requireArg:
          '--config features.apps=false --config mcp_servers={"my.server"={enabled=false},"my server"={enabled=false}} --config mcp_servers.my server.enabled=false --ephemeral',
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const result = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Remove default shapes from characters",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });
          expect(result.title).toBe("Remove default shapes");
        }),
    ),
  );
});
