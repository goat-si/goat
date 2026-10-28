import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { DEFAULT_TERMINAL_ID } from "@goat/contracts";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { expect } from "vite-plus/test";
import * as ProcessRunner from "../processRunner.ts";
import * as TerminalManager from "./Manager.ts";
import { FakePtyAdapter } from "./Manager.testkit.ts";

const openInput = (overrides: { threadId?: string } = {}) => ({
  threadId: "thread-1",
  terminalId: DEFAULT_TERMINAL_ID,
  cwd: process.cwd(),
  cols: 100,
  rows: 24,
  ...overrides,
});

it.layer(
  Layer.mergeAll(
    NodeServices.layer,
    McpProviderSessions.layer,
    ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
  ),
  { excludeTestServices: true },
)("terminal metadata initialization", (it) => {
  it.effect("reconciles metadata churn during initial delivery with a fresh snapshot", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const logsDir = yield* fs.makeTempDirectoryScoped({ prefix: "terminal-metadata-" });
      const manager = yield* TerminalManager.makeWithOptions({
        logsDir,
        ptyAdapter: new FakePtyAdapter(),
        processKillGraceMs: 1,
      });
      yield* manager.open(openInput());
      const delivered: string[] = [];
      const snapshots: string[][] = [];
      const stop = yield* manager.subscribeMetadata((event) =>
        Effect.gen(function* () {
          delivered.push(event.type);
          if (event.type !== "snapshot") return;
          snapshots.push(event.terminals.map((terminal) => terminal.threadId));
          if (snapshots.length !== 1) return;
          for (let index = 0; index < 8; index++) {
            const input = openInput({ threadId: `transient-${index}` });
            yield* manager.open(input);
            yield* manager.close(input);
          }
          yield* manager.close(openInput());
          yield* manager.open(openInput({ threadId: "survivor" }));
        }).pipe(Effect.orDie),
      );
      expect(delivered).toEqual(["snapshot", "snapshot"]);
      expect(snapshots).toEqual([["thread-1"], ["survivor"]]);
      yield* manager.close(openInput({ threadId: "survivor" }));
      expect(delivered.at(-1)).toBe("remove");
      stop();
    }),
  );
});
