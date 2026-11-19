// @effect-diagnostics nodeBuiltinImport:off -- The race uses two real Node processes and the real SQLite lock.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { guardChild } from "@goat/shared/errorGuards";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import { tryAcquireServerOwnerLock } from "./serverOwnerLockFile.ts";

it.live.each([0, 1])(
  "an SSH launch and a service successor cannot both own a home (winner %s)",
  (first) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* fs.makeTempDirectoryScoped({ prefix: "goat-owner-race-" });
      const seed = tryAcquireServerOwnerLock(state, "seed");
      assert.isDefined(seed);
      seed?.release();
      const moduleUrl = NodeURL.pathToFileURL(
        NodeURL.fileURLToPath(new URL("./serverOwnerLockFile.ts", import.meta.url)),
      ).href;
      const script = `import { tryAcquireServerOwnerLock } from ${JSON.stringify(moduleUrl)};
let lock;
process.on('message', value => {
  if (value === 'go') {
    lock = tryAcquireServerOwnerLock(${JSON.stringify(state)}, process.argv[1]);
    process.send({ owned: !!lock });
    if (!lock) { console.error('Another GOAT server owns this home'); process.exitCode = 78; process.disconnect(); }
  } else if (value === 'release') { lock.release(); process.disconnect(); }
});
process.send({ ready: true });`;
      const children = ["ssh", "old-service"].map((name) => {
        const ready = Promise.withResolvers<void>();
        const outcome = Promise.withResolvers<boolean>();
        const closed = Promise.withResolvers<number | null>();
        let stderr = "";
        const child = guardChild(
          NodeChildProcess.spawn(process.execPath, ["--input-type=module", "-e", script, name], {
            stdio: ["ignore", "ignore", "pipe", "ipc"],
          }),
          (error) => {
            ready.reject(error);
            outcome.reject(error);
            closed.reject(error);
          },
        );
        child.on("message", (value) => {
          if (typeof value !== "object" || value === null) return;
          if ("ready" in value) ready.resolve();
          if ("owned" in value) outcome.resolve(value.owned === true);
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr = (stderr + chunk.toString()).slice(-1024);
        });
        child.once("close", (code) => closed.resolve(code));
        return {
          child,
          ready: ready.promise,
          outcome: outcome.promise,
          closed: closed.promise,
          stderr: () => stderr,
        };
      });
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          for (const c of children)
            if (c.child.exitCode === null && c.child.signalCode === null) c.child.kill("SIGTERM");
          await Promise.all(children.map((c) => c.closed));
        }),
      );
      yield* Effect.promise(() => Promise.all(children.map((c) => c.ready)));
      children[first]!.child.send("go");
      assert.isTrue(yield* Effect.promise(() => children[first]!.outcome));
      children[1 - first]!.child.send("go");
      const results = yield* Effect.promise(() => Promise.all(children.map((c) => c.outcome)));
      assert.equal(results.filter(Boolean).length, 1);
      const winner = children[results.indexOf(true)]!;
      const loser = children[results.indexOf(false)]!;
      assert.equal(yield* Effect.promise(() => loser.closed), 78);
      assert.include(loser.stderr(), "Another GOAT server owns this home");
      winner.child.send("release");
      assert.equal(yield* Effect.promise(() => winner.closed), 0);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
