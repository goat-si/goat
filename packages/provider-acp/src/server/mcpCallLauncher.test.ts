import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { writeAcpMcpCallLauncher } from "./mcpCallLauncher.ts";

describe("ACP Windows launcher", () => {
  it.effect("publishes complete identical launchers under concurrent creation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped();
      const paths = yield* Effect.all(
        Array.from({ length: 8 }, () => writeAcpMcpCallLauncher(dir, true)),
        { concurrency: "unbounded" },
      );
      expect(new Set(paths).size).toBe(1);
      const content = yield* fs.readFileString(path.join(dir, "acp", "goat-acp-mcp-call.cmd"));
      expect(content).toContain(
        '"%GOAT_ACP_MCP_NODE%" "%GOAT_ACP_MCP_ENTRYPOINT%" acp-mcp-call %*',
      );
      expect(content).toContain("exit /b %errorlevel%");
      expect(yield* fs.readDirectory(path.join(dir, "acp"))).toEqual(["goat-acp-mcp-call.cmd"]);
      expect(yield* writeAcpMcpCallLauncher(dir, false)).toBeUndefined();
      const blocker = path.join(dir, "blocker");
      yield* fs.writeFileString(blocker, "file");
      expect(yield* Effect.flip(writeAcpMcpCallLauncher(blocker, true))).toBeDefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
