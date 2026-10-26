import type {
  ComputerUseAgentCursor,
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
  /** Where the helper draws the agent's cursor on that window, for the preview to draw too. */
  readonly cursor?: ComputerUseAgentCursor;
}

export interface ComputerUseControlSnapshot extends ComputerUseControl {
  readonly ended?: ComputerUseControlEnd;
}

/** A grant read for an older control must not change the replacement's remembered scope. */
export const rememberScope = <C extends ComputerUseControl>(
  controls: Map<ThreadId, C>,
  record: C,
  apps: ReadonlyArray<string> | undefined,
) => {
  const current = controls.get(record.threadId);
  if (current?.controlId === record.controlId)
    controls.set(record.threadId, { ...current, scope: { apps } });
  return apps;
};

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

/** The agent's cursor a proxy reports, or null when the overlay draws none. */
export type Cursor = ComputerUseAgentCursor | null;

const sameCursor = (a: ComputerUseAgentCursor | undefined, b: ComputerUseAgentCursor | undefined) =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.windowId === b.windowId &&
    a.phase === b.phase &&
    a.point.fx === b.point.fx &&
    a.point.fy === b.point.fy);

/**
 * The record with the agent's cursor set, or cleared by null or a point on another window than
 * the target; undefined when nothing changes.
 */
const withCursor = <C extends ComputerUseControl>(record: C, cursor: Cursor): C | undefined => {
  const next = cursor !== null && cursor.windowId === record.target?.windowId ? cursor : undefined;
  if (sameCursor(next, record.cursor)) return undefined;
  const { cursor: _previous, ...rest } = record;
  return (next === undefined ? rest : { ...rest, cursor: next }) as C;
};

/**
 * The record after a proxy's report: a new target window, which drops a cursor on the previous
 * one, or the cursor itself. Undefined when nothing changes.
 */
export const targeted = <C extends ComputerUseControl>(
  record: C,
  report: { readonly pid: number; readonly windowId: number } | { readonly cursor: Cursor },
): C | undefined => {
  if ("cursor" in report) return withCursor(record, report.cursor);
  if (record.target?.pid === report.pid && record.target.windowId === report.windowId) return;
  const moved = { ...record, target: { pid: report.pid, windowId: report.windowId } };
  return withCursor(moved, null) ?? moved;
};
