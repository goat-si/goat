import * as NodeServices from "@goat/shared/testing/nodeServicesWithCrypto";
import { it } from "@effect/vitest";
import { DEFAULT_TERMINAL_ID } from "@goat/contracts";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { expect } from "vite-plus/test";
import * as ProcessRunner from "../processRunner.ts";
import { createManager, openInput } from "./Manager.testkit.ts";

it.layer(
  Layer.mergeAll(
    NodeServices.layer,
    McpProviderSessions.layer,
    ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
  ),
  { excludeTestServices: true },
)("Terminal clear persistence", (it) => {
  it.effect("clears a terminal that keeps printing while history is saved", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      let printWhileSaving = Effect.void;
      const printing = FileSystem.FileSystem.of({
        ...fs,
        writeFileString: (filePath, data, options) =>
          printWhileSaving.pipe(Effect.andThen(fs.writeFileString(filePath, data, options))),
      });
      const { manager, ptyAdapter, getEvents } = yield* createManager().pipe(
        Effect.provideService(FileSystem.FileSystem, printing),
      );
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0]!;
      let saves = 0;
      printWhileSaving = Effect.gen(function* () {
        saves += 1;
        if (saves > 2) return;
        const printed = yield* Deferred.make<void>();
        const unsubscribe = yield* manager.subscribe((event) =>
          event.type === "output" ? Deferred.succeed(printed, undefined) : Effect.void,
        );
        process.emitData("tick\n");
        yield* Deferred.await(printed);
        unsubscribe();
      });
      yield* manager.clear({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID });
      expect((yield* getEvents).map((event) => event.type)).toContain("cleared");
      expect(saves).toBeLessThan(3);
      printWhileSaving = Effect.void;
    }),
  );
  it.effect("keeps cleared history empty after close and reopen", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const seen = yield* Deferred.make<void>();
      const unsubscribe = yield* manager.subscribe((event) =>
        event.type === "output" ? Deferred.succeed(seen, undefined) : Effect.void,
      );
      ptyAdapter.processes[0]!.emitData("before clear\n");
      yield* Deferred.await(seen);
      unsubscribe();
      yield* manager.clear({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID });
      yield* manager.close({ threadId: "thread-1" });
      expect((yield* manager.open(openInput())).history).toBe("");
    }),
  );
});
