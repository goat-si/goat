import * as NodeServices from "@goat/shared/testing/nodeServicesWithCrypto";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, type TerminalAttachStreamEvent } from "@goat/contracts";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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
import * as TerminalManager from "./Manager.ts";
import { createManager, FakePtyAdapter, openInput } from "./Manager.testkit.ts";
import { TerminalThreadWorktreeError } from "./TerminalThreadWorktree.ts";

// goat#3674: a restore holds a folder's lease and then takes the thread's terminal lock for its
// setup terminal, so a terminal request must never wait on that lease while holding the lock.
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
    "an attach left during its rerun, before its shell starts, gives back the lease and the thread",
    () =>
      Effect.gen(function* () {
        const resolving = yield* Deferred.make<void>();
        let calls = 0;
        // The second resolve is the rerun's, which holds the lease and the thread lock.
        const { manager, ptyAdapter } = yield* createManager(5, {
          resolveProviderInstanceEnvironment: (_id, env) => {
            calls += 1;
            return calls === 2
              ? Deferred.succeed(resolving, undefined).pipe(Effect.andThen(Effect.never))
              : Effect.succeed(env ?? {});
          },
        });
        const folder = yield* heldFolder;
        const input = openInput({
          cwd: folder.cwd,
          providerInstanceId: ProviderInstanceId.make("provider"),
        });
        const holder = yield* folder.hold(Effect.void);
        yield* Deferred.await(folder.held);
        const attach = yield* manager
          .attachStream(input, () => Effect.void)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.succeed(folder.release, undefined);
        yield* Fiber.join(holder);
        yield* Deferred.await(resolving);
        assert.isFalse(yield* leaseFree(folder.cwd));
        yield* Fiber.interrupt(attach);
        assert.isTrue(yield* leaseFree(folder.cwd));
        yield* manager.open(openInput({ terminalId: "other", cwd: folder.other }));
        assert.deepEqual(
          ptyAdapter.spawnInputs.map((spawned) => spawned.cwd),
          [folder.other],
        );
      }),
  );

  it.effect("a close sent while an open waits is not undone when the open runs again", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const folder = yield* heldFolder;
      const input = openInput({ cwd: folder.cwd });
      const holder = yield* folder.hold(Effect.void);
      yield* Deferred.await(folder.held);
      const opened = yield* Effect.exit(manager.open(input)).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* manager.close({ threadId: input.threadId, terminalId: input.terminalId });
      yield* Deferred.succeed(folder.release, undefined);
      yield* Fiber.join(holder);
      const exit = yield* Fiber.join(opened);
      assert.isTrue(Exit.isFailure(exit));
      assert.deepEqual(ptyAdapter.spawnInputs, []);
      assert.isTrue(Exit.isFailure(yield* Effect.exit(manager.getShell(input))));
    }),
  );

  it.effect("a thread deleted while an open waits gets no shell afterwards", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const folder = yield* heldFolder;
      const input = openInput({ cwd: folder.cwd });
      const holder = yield* folder.hold(Effect.void);
      yield* Deferred.await(folder.held);
      const opened = yield* Effect.exit(manager.open(input)).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* manager.close({ threadId: input.threadId, deleteHistory: true });
      yield* Deferred.succeed(folder.release, undefined);
      yield* Fiber.join(holder);
      assert.isTrue(Exit.isFailure(yield* Fiber.join(opened)));
      assert.deepEqual(ptyAdapter.spawnInputs, []);
    }),
  );

  it.effect(
    "a newer open of the same terminal in another folder outlives an older one that waited",
    () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter } = yield* createManager();
        const folder = yield* heldFolder;
        const holder = yield* folder.hold(Effect.void);
        yield* Deferred.await(folder.held);
        const older = yield* manager
          .open(openInput({ cwd: folder.cwd }))
          .pipe(Effect.forkChild({ startImmediately: true }));
        const newer = yield* manager.open(openInput({ cwd: folder.other }));
        yield* Deferred.succeed(folder.release, undefined);
        yield* Fiber.join(holder);
        const fromOlder = yield* Fiber.join(older);
        assert.deepEqual(
          ptyAdapter.spawnInputs.map((spawned) => spawned.cwd),
          [folder.other],
        );
        assert.strictEqual(fromOlder.pid, newer.pid);
        assert.strictEqual(fromOlder.cwd, folder.other);
      }),
  );

  it.effect(
    "a terminal's try right after a release does not overtake a waiter already queued",
    () =>
      Effect.gen(function* () {
        const { manager } = yield* createManager();
        const folder = yield* heldFolder;
        const events: Array<string> = [];
        // The holder opens a terminal the moment it lets go, while a waiter is queued.
        const holder = yield* withWorkspaceLease(
          folder.cwd,
          Deferred.succeed(folder.held, undefined).pipe(
            Effect.andThen(Deferred.await(folder.release)),
          ),
        ).pipe(
          Effect.andThen(manager.open(openInput({ cwd: folder.cwd }))),
          Effect.tap(() => Effect.sync(() => events.push("terminal opened"))),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.await(folder.held);
        const waiter = yield* withWorkspaceLease(
          folder.cwd,
          Effect.sync(() => events.push("waiter entered")),
        ).pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.succeed(folder.release, undefined);
        yield* Fiber.join(holder);
        yield* Fiber.join(waiter);
        assert.deepEqual(events, ["waiter entered", "terminal opened"]);
      }),
  );

  it.effect(
    "an attach that ran again leaves one viewer, so a later wider open is not narrowed",
    () =>
      Effect.gen(function* () {
        const { manager } = yield* createManager();
        const folder = yield* heldFolder;
        const holder = yield* folder.hold(Effect.void);
        yield* Deferred.await(folder.held);
        const attach = yield* manager
          .attachStream(
            openInput({ cwd: folder.cwd, cols: 40, rows: 10 }),
            () => Effect.void,
            undefined,
            "viewer",
          )
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.succeed(folder.release, undefined);
        yield* Fiber.join(holder);
        const stop = yield* Fiber.join(attach);
        stop();
        const reopened = yield* manager.open(openInput({ cwd: folder.cwd, cols: 120, rows: 30 }));
        assert.strictEqual(reopened.cols, 120);
      }),
  );

  it.effect(
    "of two opens that waited for one terminal, the second returns the first one's shell",
    () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter } = yield* createManager();
        const folder = yield* heldFolder;
        const holder = yield* folder.hold(Effect.void);
        yield* Deferred.await(folder.held);
        const first = yield* manager
          .open(openInput({ cwd: folder.cwd }))
          .pipe(Effect.forkChild({ startImmediately: true }));
        const second = yield* manager
          .open(openInput({ cwd: folder.cwd, cols: 90 }))
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.succeed(folder.release, undefined);
        yield* Fiber.join(holder);
        const fromFirst = yield* Fiber.join(first);
        const fromSecond = yield* Fiber.join(second);
        assert.strictEqual(ptyAdapter.spawnInputs.length, 1);
        assert.strictEqual(fromSecond.pid, fromFirst.pid);
      }),
  );

  it.effect.each([
    ["is gone", Effect.succeedNone, "TerminalSessionLookupError"],
    [
      "cannot be read",
      Effect.fail(new TerminalThreadWorktreeError({ cause: "unreadable" })),
      "TerminalCwdStatError",
    ],
    ["moved elsewhere", Effect.succeedSome("/elsewhere"), "TerminalCwdStatError"],
  ] as const)(
    "an open that waited starts nothing when its thread's worktree %s",
    ([, current, failure]) =>
      Effect.gen(function* () {
        const folder = yield* heldFolder;
        const fs = yield* FileSystem.FileSystem;
        const ptyAdapter = new FakePtyAdapter();
        const manager = yield* TerminalManager.makeWithOptions({
          logsDir: yield* fs.makeTempDirectoryScoped({ prefix: "goat-terminal-logs-" }),
          ptyAdapter,
          processKillGraceMs: 1,
          threadWorktree: { current: () => current },
        });
        const holder = yield* folder.hold(Effect.void);
        yield* Deferred.await(folder.held);
        const opened = yield* Effect.flip(
          manager.open(openInput({ cwd: folder.cwd, worktreePath: folder.cwd })),
        ).pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.succeed(folder.release, undefined);
        yield* Fiber.join(holder);
        const error = yield* Fiber.join(opened);
        assert.strictEqual(error._tag, failure);
        if (error._tag === "TerminalCwdStatError") assert.strictEqual(error.cwd, folder.cwd);
        assert.deepEqual(ptyAdapter.spawnInputs, []);
      }),
  );
});
