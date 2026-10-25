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
 * Marks the thread's live control as asked to act through by an agent's call this turn; false
 * when it is not live or already marked. Until then the session list shows no card for it.
 */
export const markActed = <C extends ComputerUseControl & { readonly ended?: unknown }>(
  controls: Map<ThreadId, C>,
  threadId: ThreadId,
  call: { readonly controlId: string },
) => {
  const control = controls.get(threadId);
  if (
    control?.controlId !== call.controlId ||
    control.ended !== undefined ||
    control.idle === true ||
    control.acted === true
  )
    return false;
  controls.set(threadId, { ...control, acted: true });
  return true;
};

/**
 * A control as a new turn takes it up: active again, so the session list that hid it while idle
 * may show it, and unmarked if it sat idle between turns, since that turn has not asked for the
 * screen yet. A stopped card keeps its mark while idle.
 */
export const nextTurn = <C extends ComputerUseControl>({ idle, acted, ...rest }: C) =>
  idle !== true && acted === true ? { ...rest, acted } : rest;

/**
 * Whether a person sees a card for this control in this state: its agent acted through it, and
 * a person stopped it or one of its turns is live (#1360, #1555). The session list and the
 * stopped-card merge both judge by this, so a thread never shows two cards or none.
 */
export const hasCard = (control: ComputerUseControl, state: ComputerUseControlState) =>
  control.acted === true &&
  (state._tag === "ended"
    ? state.reason === "stopped" || state.reason === "stopped_all"
    : control.idle !== true);

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
