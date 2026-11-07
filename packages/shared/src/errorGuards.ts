// @effect-diagnostics nodeBuiltinImport:off - Guards raw Node emitters where they are created.
import type * as NodeChildProcess from "node:child_process";
import type * as NodeEvents from "node:events";

/** Where an emitter's 'error' goes: end or fail whatever owns the emitter. */
export type ErrorRoute = (error: Error) => void;

/** Hears 'error' from the moment the emitter exists (docs/internals/server-resilience.md). */
export function guardErrors<T extends NodeEvents.EventEmitter>(emitter: T, route: ErrorRoute): T {
  emitter.on("error", route);
  return emitter;
}

/**
 * guardErrors for a child and each of its piped stdio streams. Only stdin may take its own route:
 * a write to a child that closed its end fails there, while the child's exit reports the outcome.
 */
export function guardChild<T extends NodeChildProcess.ChildProcess>(
  child: T,
  route: ErrorRoute,
  stdinRoute: ErrorRoute = route,
): T {
  child.on("error", route);
  child.stdin?.on("error", stdinRoute);
  for (const stream of child.stdio.slice(1)) stream?.on("error", route);
  return child;
}
