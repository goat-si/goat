// @effect-diagnostics nodeBuiltinImport:off -- a second Node process plays another GOAT server on this machine.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@goat/shared/HostProcess";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";

import {
  tryWithForeignWorkspaceSubtree,
  tryWithWorkspaceLease,
  tryWithWorkspaceSubtree,
  withWorkspaceLease,
} from "./workspaceLease.ts";
import { enableWorkspaceLeaseRegistry } from "./workspaceLeaseRegistry.ts";

it.effect("rejects contention without entering the checkout and admits a later attempt", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = "/lease-test/contention";
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* withWorkspaceLease(
        cwd,
        Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(held);
      const skipped = yield* tryWithWorkspaceLease(
        cwd,
        Effect.die("must not enter a busy checkout"),
      );
      assert.isTrue(Option.isNone(skipped));
      // Different workspaces remain independent while the holder is still busy.
      assert.deepEqual(
        yield* tryWithWorkspaceLease("/lease-test/other", Effect.succeed(1)),
        Option.some(1),
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      assert.deepEqual(yield* tryWithWorkspaceLease(cwd, Effect.succeed(2)), Option.some(2));
    }),
  ),
);

it.effect("releases a nonblocking lease after failure and holder interruption", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = "/lease-test/interrupt-holder";
      assert.equal(
        yield* tryWithWorkspaceLease(cwd, Effect.fail("failed")).pipe(Effect.flip),
        "failed",
      );
      const held = yield* Deferred.make<void>();
      const holder = yield* tryWithWorkspaceLease(
        cwd,
        Deferred.succeed(held, undefined).pipe(Effect.andThen(Effect.never)),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(held);
      assert.isTrue(Option.isNone(yield* tryWithWorkspaceLease(cwd, Effect.void)));
      yield* Fiber.interrupt(holder);
      assert.deepEqual(yield* withWorkspaceLease(cwd, Effect.succeed("released")), "released");
    }),
  ),
);

it.effect("interrupting a blocking waiter does not release the holder's lease", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = "/lease-test/interrupt-waiter";
      const held = yield* Deferred.make<void>();
      const holder = yield* withWorkspaceLease(
        cwd,
        Deferred.succeed(held, undefined).pipe(Effect.andThen(Effect.never)),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(held);
      const waiterEntered = yield* Deferred.make<void>();
      const waiter = yield* Deferred.succeed(waiterEntered, undefined).pipe(
        Effect.andThen(withWorkspaceLease(cwd, Effect.die("waiter must not enter"))),
        Effect.forkChild,
      );
      yield* Deferred.await(waiterEntered);
      yield* Fiber.interrupt(waiter);
      assert.isTrue(Option.isNone(yield* tryWithWorkspaceLease(cwd, Effect.void)));
      yield* Fiber.interrupt(holder);
      assert.deepEqual(yield* tryWithWorkspaceLease(cwd, Effect.succeed(3)), Option.some(3));
    }),
  ),
);

it.effect(
  "a folder held whole admits no lease inside it but its holder's, and lets waiters in after",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = "/lease-test/tree";
        const held = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let holderDone = false;
        const holder = yield* tryWithWorkspaceSubtree(
          root,
          Effect.gen(function* () {
            // The removal takes the leases it needs inside the folder it holds.
            assert.equal(yield* withWorkspaceLease(root + "/pkg", Effect.succeed("own")), "own");
            yield* Deferred.succeed(held, undefined);
            yield* Deferred.await(release);
            holderDone = true;
          }),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(held);
        // A thread bound inside the folder cannot start while it is held.
        assert.isTrue(
          Option.isNone(
            yield* tryWithWorkspaceLease(root + "/packages/app", Effect.die("must not start")),
          ),
        );
        assert.deepEqual(
          yield* tryWithWorkspaceLease("/lease-test/treehouse", Effect.succeed(1)),
          Option.some(1),
        );
        const waiter = yield* withWorkspaceLease(
          root + "/pkg",
          Effect.sync(() => holderDone),
        ).pipe(Effect.forkChild);
        yield* Deferred.succeed(release, undefined);
        assert.deepEqual(yield* Fiber.join(holder), Option.some(undefined));
        assert.isTrue(yield* Fiber.join(waiter));
      }),
    ),
);

it.effect(
  "a folder is not held whole while a lease inside it is held or another hold overlaps",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = "/lease-test/busy";
        const held = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const worker = yield* withWorkspaceLease(
          root + "/pkg",
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(held);
        assert.isTrue(
          Option.isNone(yield* tryWithWorkspaceSubtree(root, Effect.die("must not remove"))),
        );
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(worker);
        const nested = yield* tryWithWorkspaceSubtree(
          root,
          tryWithWorkspaceSubtree(root + "/inner", Effect.die("must not overlap")),
        );
        assert.deepEqual(nested, Option.some(Option.none()));
      }),
    ),
);

it.effect("a folder held whole is held through every alias of it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const base = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "lease-alias-" }),
      );
      const real = base + "/real";
      yield* fs.makeDirectory(real + "/pkg", { recursive: true });
      yield* fs.symlink(real, base + "/alias");
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* tryWithWorkspaceSubtree(
        real,
        Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(held);
      assert.isTrue(Option.isNone(yield* tryWithWorkspaceLease(base + "/alias/pkg", Effect.void)));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      // And a lease taken through the alias keeps the real folder from being held whole.
      const leased = yield* Deferred.make<void>();
      const done = yield* Deferred.make<void>();
      const worker = yield* withWorkspaceLease(
        base + "/alias/pkg",
        Deferred.succeed(leased, undefined).pipe(Effect.andThen(Deferred.await(done))),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(leased);
      assert.isTrue(Option.isNone(yield* tryWithWorkspaceSubtree(real, Effect.void)));
      yield* Deferred.succeed(done, undefined);
      yield* Fiber.join(worker);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("interrupting a removal that holds a folder whole releases it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = "/lease-test/interrupted-hold";
      const held = yield* Deferred.make<void>();
      const holder = yield* tryWithWorkspaceSubtree(
        root,
        Deferred.succeed(held, undefined).pipe(Effect.andThen(Effect.never)),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(held);
      yield* Fiber.interrupt(holder);
      assert.deepEqual(
        yield* tryWithWorkspaceLease(root + "/pkg", Effect.succeed("started")),
        Option.some("started"),
      );
      assert.deepEqual(yield* tryWithWorkspaceSubtree(root, Effect.succeed(1)), Option.some(1));
    }),
  ),
);

/**
 * Another GOAT server on this machine, such as Nightly beside stable: a Node process that joins the
 * same lease registry and takes leases or holds on request. It answers each request with one line.
 */
const CHILD_SOURCE = `
const { leases, registry, dir } = JSON.parse(process.env.GOAT_LEASE_CHILD);
const Effect = await import("effect/Effect");
const Deferred = await import("effect/Deferred");
const { createInterface } = await import("node:readline");
const lease = await import(leases);
const { enableWorkspaceLeaseRegistry } = await import(registry);
const { holder } = enableWorkspaceLeaseRegistry(dir);
const held = [];
process.stdout.write("ready " + holder + "\\n");
for await (const line of createInterface({ input: process.stdin })) {
  const { command, path } = JSON.parse(line);
  if (command === "release") {
    const claim = held.pop();
    await Effect.runPromise(Deferred.succeed(claim.release, undefined));
    await claim.done;
    process.stdout.write("released\\n");
    continue;
  }
  const entered = Effect.runSync(Deferred.make());
  const release = Effect.runSync(Deferred.make());
  const take = command === "lease" ? lease.tryWithWorkspaceLease : lease.tryWithWorkspaceSubtree;
  const done = Effect.runPromise(
    take(path, Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))),
  );
  const outcome = await Promise.race([
    Effect.runPromise(Deferred.await(entered)).then(() => "held"),
    done.then(() => "busy"),
  ]);
  if (outcome === "held") held.push({ release, done });
  process.stdout.write(outcome + "\\n");
}
`;

const exited = (child: NodeChildProcess.ChildProcess) =>
  Effect.callback<void>((resume) => {
    if (child.exitCode !== null || child.signalCode !== null) return resume(Effect.void);
    child.once("exit", () => resume(Effect.void));
  });

const otherServer = (dir: string) =>
  Effect.gen(function* () {
    const lines = yield* Queue.unbounded<string>();
    const child = yield* Effect.acquireRelease(
      Effect.sync(() =>
        NodeChildProcess.spawn(process.execPath, ["--input-type=module", "-e", CHILD_SOURCE], {
          cwd: NodePath.resolve(import.meta.dirname, "../.."),
          env: {
            ...process.env,
            GOAT_LEASE_CHILD: JSON.stringify({
              leases: NodeURL.pathToFileURL(NodePath.join(import.meta.dirname, "workspaceLease.ts"))
                .href,
              registry: NodeURL.pathToFileURL(
                NodePath.join(import.meta.dirname, "workspaceLeaseRegistry.ts"),
              ).href,
              dir,
            }),
          },
          stdio: ["pipe", "pipe", "inherit"],
        }),
      ),
      (child) => {
        child.kill("SIGKILL");
        return exited(child);
      },
    );
    NodeReadline.createInterface({ input: child.stdout! }).on("line", (line) => {
      Queue.offerUnsafe(lines, line);
    });
    // A child that dies early answers every pending request with its exit.
    child.once("exit", (code, signal) => {
      Queue.offerUnsafe(lines, `exit ${code ?? signal}`);
    });
    const answer = (command: string, path?: string) =>
      Effect.sync(() => child.stdin!.write(JSON.stringify({ command, path }) + "\n")).pipe(
        Effect.andThen(Queue.take(lines)),
      );
    const ready = yield* Queue.take(lines);
    assert.match(ready, /^ready /u);
    return {
      holder: ready.slice("ready ".length),
      answer,
      /** Kills it by the PID it was spawned with, as a crash would. */
      crash: Effect.sync(() => child.kill("SIGKILL")).pipe(Effect.andThen(exited(child))),
    };
  });

/** This process and another server joined to one registry, with a folder both can reach. */
const twoServers = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const base = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "lease-servers-" }));
  const dir = base + "/registry";
  const folder = base + "/worktree";
  yield* fs.makeDirectory(folder + "/inner", { recursive: true });
  const joined = yield* Effect.acquireRelease(
    Effect.sync(() => enableWorkspaceLeaseRegistry(dir)),
    (joined) => Effect.sync(() => joined.disable()),
  );
  const other = yield* otherServer(dir);
  return { fs, base, dir, folder, other, holder: joined.holder };
});

/** The key a server records for a folder, as workspaceLease.ts compares them. */
const recordedKey = (folder: string) =>
  HostProcess.Platform.pipe(
    Effect.map((platform) => {
      const slashed = folder.replaceAll("\\", "/");
      return platform === "linux" ? slashed : slashed.toLowerCase();
    }),
  );

it.live(
  "a lease another server holds keeps a folder from being removed, and a removal it runs keeps leases out",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { base, folder, other } = yield* twoServers;
        assert.equal(yield* other.answer("lease", folder + "/inner"), "held");
        assert.isTrue(
          Option.isNone(yield* tryWithWorkspaceSubtree(folder, Effect.die("must not remove"))),
        );
        // Leases exclude removals only; two servers working in one folder do not wait on each other.
        assert.deepEqual(
          yield* tryWithWorkspaceLease(folder + "/inner", Effect.succeed(1)),
          Option.some(1),
        );
        assert.equal(yield* other.answer("release"), "released");
        assert.deepEqual(yield* tryWithWorkspaceSubtree(folder, Effect.succeed(2)), Option.some(2));

        const held = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const removal = yield* tryWithWorkspaceSubtree(
          folder,
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(held);
        assert.equal(yield* other.answer("lease", folder + "/inner"), "busy");
        assert.equal(yield* other.answer("subtree", base), "busy");
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(removal);
        assert.equal(yield* other.answer("lease", folder + "/inner"), "held");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "a folder another server holds whole stays held through aliases until it releases or dies",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fs, base, folder, other } = yield* twoServers;
        yield* fs.symlink(folder, base + "/alias");
        assert.equal(yield* other.answer("subtree", folder), "held");
        assert.isTrue(
          Option.isNone(yield* tryWithWorkspaceLease(base + "/alias/inner", Effect.die("busy"))),
        );
        assert.isTrue(
          Option.isNone(yield* tryWithWorkspaceSubtree(folder + "/inner", Effect.die("busy"))),
        );
        assert.isTrue(Option.isNone(yield* tryWithWorkspaceSubtree(base, Effect.die("busy"))));

        const waiter = yield* withWorkspaceLease(folder + "/inner", Effect.succeed("after")).pipe(
          Effect.forkChild,
        );
        const cancelled = yield* withWorkspaceLease(
          folder + "/other",
          Effect.die("an interrupted waiter must not enter"),
        ).pipe(Effect.forkChild);
        yield* Fiber.interrupt(cancelled);
        assert.equal(yield* other.answer("release"), "released");
        assert.equal(yield* Fiber.join(waiter), "after");

        assert.equal(yield* other.answer("subtree", folder), "held");
        yield* other.crash;
        assert.deepEqual(
          yield* tryWithWorkspaceLease(folder + "/inner", Effect.succeed("reclaimed")),
          Option.some("reclaimed"),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "a hold another server has only just published counts, a dead server's does not, and an unreadable one stops",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fs, dir, folder, other } = yield* twoServers;
        const key = yield* recordedKey(folder);
        // What the other server has written before it reads anyone else's claims.
        const published = `${dir}/${other.holder}.900.json`;
        const hold = JSON.stringify({
          holder: other.holder,
          kind: "subtree",
          key,
        });
        yield* fs.writeFileString(published, hold);
        assert.isTrue(
          Option.isNone(yield* tryWithWorkspaceLease(folder + "/inner", Effect.die("busy"))),
        );
        yield* fs.remove(published);

        const orphan = dir + "/0dead.1.json";
        yield* fs.writeFileString(
          orphan,
          JSON.stringify({ holder: "0dead", kind: "subtree", key }),
        );
        assert.deepEqual(
          yield* tryWithWorkspaceLease(folder + "/inner", Effect.succeed(1)),
          Option.some(1),
        );
        assert.isFalse(yield* fs.exists(orphan));

        yield* fs.writeFileString(`${dir}/${other.holder}.901.json`, "{");
        const tried = yield* tryWithWorkspaceLease(folder + "/inner", Effect.void).pipe(
          Effect.flip,
        );
        assert.equal(tried._tag, "WorkspaceLeaseUnavailableError");
        const waited = yield* withWorkspaceLease(folder + "/inner", Effect.void).pipe(Effect.flip);
        assert.equal(waited._tag, "WorkspaceLeaseUnavailableError");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("a rollback under its own lease keeps only other servers out", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { folder, other } = yield* twoServers;
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      // Turn start holds the lease on the checkout it is recreating when that fails.
      const turnStart = yield* withWorkspaceLease(
        folder,
        Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(held);
      assert.isTrue(Option.isNone(yield* tryWithWorkspaceSubtree(folder, Effect.die("busy"))));
      assert.deepEqual(
        yield* tryWithForeignWorkspaceSubtree(folder, Effect.succeed("rolled back")),
        Option.some("rolled back"),
      );
      assert.equal(yield* other.answer("lease", folder + "/inner"), "held");
      assert.isTrue(
        Option.isNone(yield* tryWithForeignWorkspaceSubtree(folder, Effect.die("busy"))),
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(turnStart);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "a released hold whose record could not be removed blocks until the next claim removes it",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fs, base, dir, folder, other, holder } = yield* twoServers;
        const held = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const removal = yield* tryWithWorkspaceSubtree(
          folder,
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(held);
        const name = (yield* fs.readDirectory(dir)).find(
          (entry) => entry.startsWith(holder + ".") && entry.endsWith(".json"),
        );
        assert.isDefined(name);
        const record = dir + "/" + name;
        const contents = yield* fs.readFileString(record);
        // A directory in its place makes the release's unlink fail.
        yield* fs.remove(record);
        yield* fs.makeDirectory(record);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(removal);
        yield* fs.remove(record, { recursive: true });
        yield* fs.writeFileString(record, contents);
        assert.equal(yield* other.answer("lease", folder + "/inner"), "busy");
        assert.deepEqual(
          yield* tryWithWorkspaceLease(base + "/elsewhere", Effect.succeed(1)),
          Option.some(1),
        );
        assert.isFalse(yield* fs.exists(record));
        assert.equal(yield* other.answer("lease", folder + "/inner"), "held");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
