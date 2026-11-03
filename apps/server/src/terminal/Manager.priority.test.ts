import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { DEFAULT_TERMINAL_ID } from "@goat/contracts";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { expect } from "vite-plus/test";
import * as ProcessRunner from "../processRunner.ts";
import * as TerminalManager from "./Manager.ts";
import { FakePtyAdapter } from "./Manager.testkit.ts";

const input = {
  threadId: "thread-1",
  terminalId: DEFAULT_TERMINAL_ID,
  cwd: process.cwd(),
  cols: 100,
  rows: 24,
};

it.layer(
  Layer.mergeAll(
    NodeServices.layer,
    McpProviderSessions.layer,
    ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
  ),
  { excludeTestServices: true },
)("terminal launch priority", (it) => {
  it.effect(
    "agent terminals run below normal priority; user terminals and user restarts do not",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const logsDir = yield* fs.makeTempDirectoryScoped({ prefix: "terminal-priority-" });
        const ptyAdapter = new FakePtyAdapter();
        const manager = yield* TerminalManager.makeWithOptions({
          logsDir,
          ptyAdapter,
          shellResolver: () => "/bin/sh",
          processKillGraceMs: 1,
        });
        yield* manager.open(input);
        const agent = yield* manager.agentOpen!({
          threadId: "thread-1",
          cwd: process.cwd(),
          owner: "agent",
          authorize: Effect.void,
        });
        expect(ptyAdapter.spawnInputs[0]?.shell).toBe("/bin/sh");
      expect(ptyAdapter.spawnInputs[1]?.shell).toMatch(/^\/(usr\/)?bin\/nice$/);
        expect(ptyAdapter.spawnInputs[1]?.args?.slice(0, 3)).toEqual(["-n", "10", "/bin/sh"]);
        yield* manager.restart({ ...input, terminalId: agent.terminalId });
        expect(ptyAdapter.spawnInputs[2]?.shell).toBe("/bin/sh");
      }).pipe(Effect.provideService(HostProcess.Platform, "linux")),
  );
});
