import * as Effect from "effect/Effect";

interface TerminalHeld {
  /** Requests waiting for a busy folder. */
  readonly waiting: number;
  /** Terminal event listeners, including every attached stream's. */
  readonly listeners: number;
}

/** Each manager's own read of what it still holds, for tests; off the service shape. */
const probes = new WeakMap<object, Effect.Effect<TerminalHeld>>();

export const registerTerminalProbe = (manager: object, probe: Effect.Effect<TerminalHeld>) => {
  probes.set(manager, probe);
};

export const heldByTerminalManager = (manager: object) =>
  probes.get(manager) ?? Effect.die(new Error("Not a TerminalManager."));
