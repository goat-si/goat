import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { BackgroundGitWork } from "./BackgroundGitWork.ts";
import { makeGitVcsDriverCore } from "./GitVcsDriverCore.ts";
import { makeSuccessfulHandle } from "./testing/configLockRegression.ts";
import { layerServerConfig } from "./testing/gitFixture.ts";

it.effect("runs background Git in its own lane so user commands never queue behind it", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const starts = yield* Queue.unbounded<string>();
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        yield* Queue.offer(
          starts,
          ChildProcess.isStandardCommand(command) ? String(command.args[0]) : "",
        );
        return ChildProcessSpawner.makeHandle({
          ...makeSuccessfulHandle("ok"),
          exitCode: Deferred.await(gate).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
        });
      }),
    );
    const driver = yield* makeGitVcsDriverCore().pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provide(layerServerConfig),
    );
    const run = (args: ReadonlyArray<string>) =>
      driver.execute({ operation: "test.gitLane", cwd: "/repo", args: [...args] });
    const background = yield* Effect.forEach(
      Array.from({ length: 12 }),
      () => run(["background"]),
      {
        concurrency: "unbounded",
      },
    ).pipe(Effect.provideService(BackgroundGitWork, true), Effect.forkChild);
    const backgroundStarts = yield* Effect.forEach(Array.from({ length: 2 }), () =>
      Queue.take(starts),
    );
    assert.deepStrictEqual(backgroundStarts, ["background", "background"]);
    const foreground = yield* Effect.forEach(Array.from({ length: 4 }), () => run(["foreground"]), {
      concurrency: "unbounded",
    }).pipe(Effect.forkChild);

    const started = yield* Effect.forEach(Array.from({ length: 4 }), () => Queue.take(starts));
    assert.deepStrictEqual(started, ["foreground", "foreground", "foreground", "foreground"]);
    yield* Deferred.succeed(gate, undefined);
    assert.equal((yield* Fiber.join(background)).length, 12);
    assert.equal((yield* Fiber.join(foreground)).length, 4);
  }).pipe(Effect.provide(NodeServices.layer)),
);
