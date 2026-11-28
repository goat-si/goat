import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as NodeServices from "@goat/shared/testing/nodeServicesWithCrypto";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";
import * as ProcessRunner from "../processRunner.ts";
import { createManager, layerWithHostPlatform, openInput } from "./Manager.testkit.ts";

it.layer(
  Layer.mergeAll(
    NodeServices.layer,
    McpProviderSessions.layer,
    ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
  ),
  { excludeTestServices: true },
)("TerminalManager steady subprocess polling", (it) => {
  it.effect("backs off polling a steady command and still sees it exit within five seconds", () =>
    Effect.gen(function* () {
      const shell = { pid: 9000, ppid: 1, name: "zsh" };
      let table = [shell, { pid: 200, ppid: 9000, name: "node" }];
      let queries = 0;
      const { manager, ptyAdapter, getEvents } = yield* createManager(5, {
        subprocessPollIntervalMs: 1_000,
        processKillGraceMs: 0,
        processTable: Effect.sync(() => {
          queries += 1;
          return table;
        }),
      }).pipe(Effect.provide(layerWithHostPlatform("linux")));
      const activity = Effect.map(getEvents, (events) =>
        events.flatMap((event) =>
          event.type === "activity" ? [event.hasRunningSubprocess ? event.label : null] : [],
        ),
      );
      yield* manager.open(openInput());

      yield* TestClock.adjust("10 minutes");
      expect(yield* activity).toEqual(["node"]);
      expect(queries).toBeGreaterThanOrEqual(115);
      expect(queries).toBeLessThanOrEqual(125);

      table = [...table, { pid: 201, ppid: 200, name: "esbuild" }];
      ptyAdapter.processes[0]!.emitData("rebuilt\r\n");
      queries = 0;
      yield* TestClock.adjust("1 second");
      expect(queries).toBe(1);

      yield* TestClock.adjust("1 minute");
      table = [shell];
      yield* TestClock.adjust("5 seconds");
      expect(yield* activity).toEqual(["node", null]);
      yield* manager.close({ threadId: "thread-1" });
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
