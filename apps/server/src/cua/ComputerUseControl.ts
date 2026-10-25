import type {
  ComputerUseControlEnd,
  ComputerUseForegroundGrant,
  ComputerUsePauseReason,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import type * as DateTime from "effect/DateTime";

/** One thread's current stretch of computer use, what its proxy was started with. */
export interface ComputerUseControl {
  readonly controlId: string;
  readonly threadId: ThreadId;
  readonly expiresAt: DateTime.Utc;
  /** The grant an unattended control lives on; interactive controls have none. */
  readonly handoffId?: TurnItemId;
  /** The apps it last held while active, so a stopped one keeps its label; absent until then. */
  readonly scope?: { readonly apps: ReadonlyArray<string> | undefined };
  /**
   * Its thread has no open run. It stays valid, so the next turn reuses it without respawning
   * the proxy, but no agent can act on it until then.
   */
  readonly idle?: boolean;
  /** An agent's call asked to act through it this turn; until then no card shows it (#1360). */
  readonly acted?: boolean;
  /** The window the agent's latest admitted call named, as its proxy reported it. */
  readonly target?: { readonly pid: number; readonly windowId: number };
}

/**
 * The live control a call asked to act through, marked for this turn; undefined when it is not
 * live or already marked. A turn reusing a control after an idle stretch starts unmarked, while
 * a stopped one keeps its mark so its card stays.
 */
export const askedToAct = <C extends ComputerUseControl & { readonly ended?: unknown }>(
  control: C | undefined,
  call: { readonly controlId: string },
): C | undefined =>
  control?.controlId === call.controlId &&
  control.ended === undefined &&
  control.idle !== true &&
  control.acted !== true
    ? { ...control, acted: true }
    : undefined;

export type ComputerUseControlState =
  | {
      readonly _tag: "active";
      readonly expiresAt: DateTime.Utc;
      /** Host pauses so far, so a proxy that missed one still ends the call it overlapped. */
      readonly interruptions: Interruptions;
      /** Absent when every app the driver admits is allowed. */
      readonly apps: ReadonlyArray<string> | undefined;
      /** When this state can next change without a signal, epoch ms. */
      readonly wakeAt: number;
      /**
       * Another thread holds a grant on this screen, so this one must not raise windows or move
       * the pointer over it.
       */
      readonly shared?: true;
      readonly idle?: true;
      readonly idleEpoch?: number;
      readonly foreground?: ReadonlyArray<ComputerUseForegroundGrant>;
    }
  | { readonly _tag: "paused"; readonly reason: ComputerUsePauseReason }
  | { readonly _tag: "ended"; readonly reason: ComputerUseControlEnd };

export interface Interruptions {
  readonly count: number;
  readonly last: ComputerUsePauseReason;
}
