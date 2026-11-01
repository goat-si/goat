import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";
// @effect-diagnostics nodeBuiltinImport:off -- git.exe must be recognized on Windows too.
import * as NodePath from "node:path";

export interface GitSpawnGate {
  readonly matches: (args: ReadonlyArray<string>) => boolean;
  readonly reached: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
}

export const gitSpawnObserverLayer = (gitCommands?: string[], gitSpawnGate?: GitSpawnGate) =>
  Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      return ChildProcessSpawner.make((command) => {
        // On Windows the driver starts git by its full path to git.exe.
        const args =
          command._tag === "StandardCommand" &&
          NodePath.parse(command.command).name.toLowerCase() === "git"
            ? command.args
            : null;
        if (args !== null) gitCommands?.push(args.join(" "));
        if (args === null || gitSpawnGate === undefined || !gitSpawnGate.matches(args)) {
          return spawner.spawn(command);
        }
        return spawner
          .spawn(command)
          .pipe(
            Effect.tap((handle) =>
              handle.exitCode.pipe(
                Effect.andThen(Deferred.succeed(gitSpawnGate.reached, undefined)),
                Effect.andThen(Deferred.await(gitSpawnGate.release)),
              ),
            ),
          );
      });
    }),
  ).pipe(Layer.provide(NodeServices.layer));
