// @effect-diagnostics nodeBuiltinImport:off -- exercise the real child process lifecycle.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ProcessRunner from "./processRunner.ts";
import { makeTempDir } from "./git/testkit/fileFixtures.ts";

it.live("interrupting a blocked stdin write terminates the child and cleans its files", () =>
  Effect.gen(function* () {
    const removedDirectory = yield* Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* makeTempDir("goat-stdin-interrupt-");
        const marker = NodePath.join(cwd, "child.pid");
        const script = NodePath.join(cwd, "child.cjs");
        NodeFS.writeFileSync(
          script,
          "require('node:fs').writeFileSync(process.argv[2], String(process.pid)); process.stdin.pause(); process.stdout.write('ready'); setInterval(() => {}, 1000);\n",
        );
        const ready = yield* Deferred.make<void>();
        const runner = yield* ProcessRunner.ProcessRunner;
        const action = yield* runner
          .run({
            command: NodeProcess.execPath,
            args: [script, marker],
            cwd,
            stdin: "a".repeat(4_000_000),
            onStdoutChunk: () => {
              Deferred.doneUnsafe(ready, Effect.void);
            },
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(ready);
        const pid = Number(NodeFS.readFileSync(marker, "utf8"));
        yield* Fiber.interrupt(action);
        assert.throws(() => NodeProcess.kill(pid, 0));
        return cwd;
      }),
    );
    assert.isFalse(NodeFS.existsSync(removedDirectory));
  }).pipe(Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
);
