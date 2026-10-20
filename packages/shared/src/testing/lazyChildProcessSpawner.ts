import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/process";

type Spawn = ChildProcessSpawner.ChildProcessSpawner["Service"]["spawn"];

/**
 * A spawner whose `spawn` body runs only when the effect runs.
 *
 * `ChildProcessSpawner.make` invokes `spawn` while `exitCode` and `string`
 * build their effects. The Node spawner returns `Effect.suspend`, so a mock
 * that records the command in the callback body reports work that never ran.
 */
export const lazyChildProcessSpawner = (
  spawn: Spawn,
): ChildProcessSpawner.ChildProcessSpawner["Service"] =>
  ChildProcessSpawner.make((command) => Effect.flatten(Effect.sync(() => spawn(command))));
