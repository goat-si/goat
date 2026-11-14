import { expect, it } from "vite-plus/test";
import { createTerminalSpawnEnv } from "./spawnEnvironment.ts";

it("expands a provider home named in any case on Windows", () => {
  const env = createTerminalSpawnEnv(
    { GROK_HOME: "C:\\inherited-grok" },
    { grok_home: "~/.grok-work" },
    "win32",
    "/home/ada",
  );
  expect(env.GROK_HOME).toBe("/home/ada/.grok-work");
});
