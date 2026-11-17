import * as NodeServices from "@goat/shared/testing/nodeServicesWithCrypto";
import { assert, it } from "@effect/vitest";
import type { TerminalAttachStreamEvent } from "@goat/contracts";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import type * as PtyAdapter from "@goat/shared/PtyAdapter";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import {
  reuseHeldWorkspaceLease,
  tryWithWorkspaceLease,
  withWorkspaceLease,
} from "../workspace/workspaceLease.ts";
import { createManager, FakePtyAdapter, openInput } from "./Manager.testkit.ts";

// goat#3674: a restore holds a folder's lease and then takes the thread's terminal lock for its
// setup terminal, so a terminal request must never wait on that lease while holding the lock.
class GatedPtyAdapter extends FakePtyAdapter {
  gate: {
    readonly spawning: Deferred.Deferred<void>;
    readonly release: Deferred.Deferred<void>;
  } | null = null;

  override spawn(input: PtyAdapter.PtySpawnInput) {
    const gate = this.gate;
    this.gate = null;
    if (!gate) return super.spawn(input);
    return Deferred.succeed(gate.spawning, undefined).pipe(
      Effect.andThen(Deferred.await(gate.release)),
      Effect.andThen(super.spawn(input)),
    );
  }
}

/** Two folders and a fiber holding the first one's lease until released. */
const heldFolder = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const { join } = yield* Path.Path;
  const base = yield* fs.makeTempDirectoryScoped({ prefix: "goat-terminal-lease-" });
  const cwd = join(base, "held");
  const other = join(base, "other");
  yield* fs.makeDirectory(cwd);
  yield* fs.makeDirectory(other);
  const held = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const events: Array<string> = [];
  const hold = <A, E>(work: Effect.Effect<A, E>) =>
    withWorkspaceLease(
      cwd,
      Effect.gen(function* () {
        yield* Deferred.succeed(held, undefined);
        yield* Deferred.await(release);
        const result = yield* work;
        events.push("holder end");
        return result;
      }),
    ).pipe(Effect.forkChild);
  return { cwd, other, held, release, events, hold };
});

const leaseFree = (cwd: string) =>
  tryWithWorkspaceLease(cwd, Effect.void).pipe(Effect.map(Option.isSome));

it.layer(
  Layer.mergeAll(
    NodeServices.layer,
    McpProviderSessions.layer,
    ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
  ),
  { excludeTestServices: true },
)("TerminalManager lease order", (it) => {
  it.effect(
    "an agent open on a held folder waits without the thread lock and returns its terminal",
    () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter } = yield* createManager();
        const folder = yield* heldFolder;
        const holder = yield* folder.hold(Effect.void);
        yield* Deferred.await(folder.held);
        const agent = yield* manager.agentOpen!({
          threadId: "thread-1",
          cwd: folder.cwd,
          owner: "agent",
          authorize: Effect.void,
        }).pipe(
          Effect.tap(() => Effect.sync(() => folder.events.push("agent opened"))),
          Effect.forkChild({ startImmediately: true }),
        );
        // The thread's other terminals keep working while the agent waits.
        yield* manager.open(openInput({ terminalId: "other", cwd: folder.other }));
        yield* Deferred.succeed(folder.release, undefined);
        yield* Fiber.join(holder);
        const opened = yield* Fiber.join(agent);
        assert.deepEqual(folder.events, ["holder end", "agent opened"]);
        assert.strictEqual(opened.status, "running");
        assert.strictEqual(opened.cwd, folder.cwd);
        assert.deepEqual(
          ptyAdapter.spawnInputs.map((input) => input.cwd),
          [folder.other, folder.cwd],
        );
      }),
  );

  it.effect(
    "an open that waited finds the terminal the holder opened meanwhile and reuses it",
    () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter } = yield* createManager();
        const folder = yield* heldFolder;
        const input = openInput({ cwd: folder.cwd });
        // As a restore's setup does: the holder opens the terminal inside its own hold.
        const holder = yield* folder.hold(reuseHeldWorkspaceLease(manager.open(input)));
        yield* Deferred.await(folder.held);
        const person = yield* manager
          .open(input)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.succeed(folder.release, undefined);
        const fromHolder = yield* Fiber.join(holder);
        const fromPerson = yield* Fiber.join(person);
        assert.strictEqual(ptyAdapter.spawnInputs.length, 1);
        assert.strictEqual(fromPerson.pid, fromHolder.pid);
        assert.strictEqual(fromPerson.status, "running");
      }),
  );

  it.effect(
    "an attach waiting on a held folder ends when its client leaves and leaves nothing behind",
    () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter } = yield* createManager();
        const folder = yield* heldFolder;
        const input = openInput({ cwd: folder.cwd });
        const holder = yield* folder.hold(Effect.void);
        yield* Deferred.await(folder.held);
        const seen: Array<TerminalAttachStreamEvent> = [];
        const attach = yield* manager
          .attachStream(input, (event) => Effect.sync(() => seen.push(event)))
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Fiber.interrupt(attach);
        // Nothing of the attach holds the thread: another terminal of it opens.
        yield* manager.open(openInput({ terminalId: "other", cwd: folder.other }));
        yield* Deferred.succeed(folder.release, undefined);
        yield* Fiber.join(holder);
        assert.isTrue(yield* leaseFree(folder.cwd));
        // A later open starts the terminal once, and the left attach hears nothing of it.
        yield* manager.open(input);
        ptyAdapter.processes.at(-1)?.emitData("after\n");
        yield* manager.close(input);
        assert.deepEqual(seen, []);
        assert.deepEqual(
          ptyAdapter.spawnInputs.map((spawned) => spawned.cwd),
          [folder.other, folder.cwd],
        );
      }),
  );

  it.effect(
    "an attach left while it waits for the thread after the folder frees gives both back",
    () =>
      Effect.gen(function* () {
        const ptyAdapter = new GatedPtyAdapter();
        const { manager } = yield* createManager(5, { ptyAdapter });
        const folder = yield* heldFolder;
        const input = openInput({ cwd: folder.cwd });
        const holder = yield* folder.hold(Effect.void);
        yield* Deferred.await(folder.held);
        const attach = yield* manager
          .attachStream(input, () => Effect.void)
          .pipe(Effect.forkChild({ startImmediately: true }));
        // Another terminal of the thread holds its lock while it spawns.
        const gate = {
          spawning: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        ptyAdapter.gate = gate;
        const other = yield* manager
          .open(openInput({ terminalId: "other", cwd: folder.other }))
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(gate.spawning);
        yield* Deferred.succeed(folder.release, undefined);
        yield* Fiber.join(holder);
        yield* Fiber.interrupt(attach);
        assert.isTrue(yield* leaseFree(folder.cwd));
        yield* Deferred.succeed(gate.release, undefined);
        yield* Fiber.join(other);
        yield* manager.open(input);
        assert.deepEqual(
          ptyAdapter.spawnInputs.map((spawned) => spawned.cwd),
          [folder.other, folder.cwd],
        );
      }),
  );
});
