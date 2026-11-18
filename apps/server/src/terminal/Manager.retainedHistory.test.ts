import * as NodeServices from "@goat/shared/testing/nodeServicesWithCrypto";
import { it } from "@effect/vitest";
import { retainedTerminalHistory } from "@goat/contracts";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { expect } from "vite-plus/test";
import * as ProcessRunner from "../processRunner.ts";
import type * as TerminalManager from "./Manager.ts";
import { createManager, type FakePtyProcess, openInput } from "./Manager.testkit.ts";

// Publishes 9 MiB of output, past a stream's 8 MiB budget, while nothing pulls.
const publishPastOutputBudget = (
  manager: TerminalManager.TerminalManager["Service"],
  process: FakePtyProcess,
) =>
  Effect.gen(function* () {
    const published = yield* Deferred.make<void>();
    const unsubscribe = yield* manager.subscribe((event) =>
      event.type === "output" && event.data === "last\n"
        ? Deferred.succeed(published, undefined).pipe(Effect.asVoid)
        : Effect.void,
    );
    for (let index = 0; index < 9; index++) process.emitData("x".repeat(1024 * 1024));
    process.emitData("last\n");
    yield* Deferred.await(published);
    unsubscribe();
  });

const emitAndWait = (
  manager: TerminalManager.TerminalManager["Service"],
  process: FakePtyProcess,
  chunks: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const last = chunks.at(-1);
    const published = yield* Deferred.make<void>();
    const unsubscribe = yield* manager.subscribe((event) =>
      event.type === "output" && event.data === last
        ? Deferred.succeed(published, undefined).pipe(Effect.asVoid)
        : Effect.void,
    );
    for (const chunk of chunks) process.emitData(chunk);
    yield* Deferred.await(published);
    unsubscribe();
  });

it.layer(
  Layer.mergeAll(
    NodeServices.layer,
    McpProviderSessions.layer,
    ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
  ),
  { excludeTestServices: true },
)("TerminalManager retained attach history", (it) => {
  it.effect("sends bounded attach streams only the history the client retains", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const maxHistoryBytes = 9;
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0]!;
      const published = yield* Deferred.make<void>();
      const unsubscribe = yield* manager.subscribe((event) =>
        event.type === "output" && event.data === "yz\n"
          ? Deferred.succeed(published, undefined).pipe(Effect.asVoid)
          : Effect.void,
      );
      process.emitData("aaaa\nx名😀");
      process.emitData("yz\n");
      yield* Deferred.await(published);
      unsubscribe();

      const full = yield* Stream.toPull(manager.attachOutputStream(openInput(), "full"));
      const bounded = yield* Stream.toPull(
        manager.attachOutputStream({ ...openInput(), maxHistoryBytes }, "bounded"),
      );
      const expectRetained = Effect.fnUntraced(function* () {
        const [fullEvents, boundedEvents] = [yield* full, yield* bounded];
        const fullSnapshot = fullEvents.at(-1);
        if (fullSnapshot?.type !== "snapshot") throw new Error("Expected a full snapshot");
        expect(boundedEvents.at(-1)).toEqual({
          ...fullSnapshot,
          snapshot: {
            ...fullSnapshot.snapshot,
            history: retainedTerminalHistory(fullSnapshot.snapshot.history, maxHistoryBytes),
          },
        });
        return fullSnapshot.snapshot.history;
      });

      expect(yield* expectRetained()).toBe("aaaa\nx名😀yz\n");
      // The cap starts inside 名, so the tail begins at the next code point.
      expect(retainedTerminalHistory("aaaa\nx名😀yz\n", maxHistoryBytes)).toBe("😀yz\n");
      process.emitData("after\n");
      expect(yield* full).toEqual(yield* bounded);

      yield* publishPastOutputBudget(manager, process);
      expect(yield* expectRetained()).toMatch(/last\n$/);

      process.emitExit({ exitCode: 0, signal: 0 });
      expect(yield* full).toEqual(yield* bounded);
      yield* manager.attachStream({ ...openInput(), restartIfNotRunning: true }, () => Effect.void);
      yield* expectRetained();
    }).pipe(Effect.scoped),
  );

  it.effect("starts a bounded snapshot after a control sequence its cut lands in", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      yield* emitAndWait(manager, ptyAdapter.processes[0]!, ["aaaa\u001b]0;title\u0007", "tail"]);

      const bounded = yield* Stream.toPull(
        manager.attachOutputStream({ ...openInput(), maxHistoryBytes: 8 }, "bounded"),
      );
      const snapshot = (yield* bounded).at(-1);
      if (snapshot?.type !== "snapshot") throw new Error("Expected a snapshot");
      expect(snapshot.snapshot.history).toBe("tail");
    }).pipe(Effect.scoped),
  );

  it.effect("sends an empty history to a client that retains none", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      yield* emitAndWait(manager, ptyAdapter.processes[0]!, ["kept on the server\n"]);

      const bounded = yield* Stream.toPull(
        manager.attachOutputStream({ ...openInput(), maxHistoryBytes: 0 }, "bounded"),
      );
      const snapshot = (yield* bounded).at(-1);
      if (snapshot?.type !== "snapshot") throw new Error("Expected a snapshot");
      expect(snapshot.snapshot.history).toBe("");
    }).pipe(Effect.scoped),
  );
});
