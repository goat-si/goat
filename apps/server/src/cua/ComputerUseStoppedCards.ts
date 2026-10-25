/**
 * What a person's Stop leaves behind on this host (#1521).
 *
 * The thread's stopped card outlives its control: a turn whose attachment was under way at the
 * Stop mints a newer control afterwards, and the card must stay until the person closes it. The
 * thread's approvals that were live at the Stop are released for that thread at once: a newer
 * control of it gets no apps from them. Other threads still see them as holders until their
 * durable end, so a failed end, then a restart, cannot leave two threads holding one app.
 *
 * @module ComputerUseStoppedCards
 */
import type { ComputerUseControlEnd, ThreadId } from "@goat/contracts";

import type { ComputerUseControl, ComputerUseControlState } from "./ComputerUseControl.ts";

type Stopped = Extract<ComputerUseControlEnd, "stopped" | "stopped_all">;
type Listed = { readonly control: ComputerUseControl; readonly state: ComputerUseControlState };

const stoppedBy = (state: ComputerUseControlState) =>
  state._tag === "ended" && (state.reason === "stopped" || state.reason === "stopped_all");

export const makeStoppedCards = () => {
  const byThread = new Map<
    ThreadId,
    { readonly control: ComputerUseControl; readonly reason: Stopped }
  >();
  const released = new Set<string>();
  return {
    /**
     * Keeps a control a newer one replaces, when a person stopped it and its card was shown: its
     * agent acted (#1555). One never shown leaves the card kept before it in place.
     */
    replaced: (
      control: ComputerUseControl & { readonly ended?: ComputerUseControlEnd | undefined },
    ) => {
      if (
        (control.ended === "stopped" || control.ended === "stopped_all") &&
        control.acted === true
      )
        byThread.set(control.threadId, { control, reason: control.ended });
    },
    release: (handoffIds: Iterable<string>) => {
      for (const id of handoffIds) released.add(id);
    },
    isReleased: (handoffId: string) => released.has(handoffId),
    /** The grants a thread may use itself: its own, minus those its Stop released. */
    own: <G extends { readonly threadId: ThreadId; readonly handoffId: string }>(
      grants: ReadonlyArray<G>,
      threadId: ThreadId,
    ) => grants.filter((grant) => grant.threadId === threadId && !released.has(grant.handoffId)),
    /**
     * The session list with one entry per stopped thread: its kept stopped card while the
     * thread's current control is not worth a card of its own (it can act on no app, or is idle
     * or gone), and nothing extra once that control is stopped too or holds a new approval.
     */
    merge: (live: ReadonlyArray<Listed>): ReadonlyArray<Listed> => {
      const kept = [...byThread.values()];
      const keptThreads = new Set(kept.map(({ control }) => control.threadId));
      const shown = live.filter(
        ({ control, state }) =>
          !(
            keptThreads.has(control.threadId) &&
            state._tag === "active" &&
            state.apps?.length === 0
          ),
      );
      // Covered by a newer control only once the list shows it: its agent acted this turn (#1555).
      const covered = new Set(
        shown
          .filter(
            ({ control, state }) =>
              control.acted === true &&
              (state._tag === "ended" ? stoppedBy(state) : control.idle !== true),
          )
          .map(({ control }) => control.threadId),
      );
      return [
        ...kept.flatMap(({ control, reason }) =>
          covered.has(control.threadId)
            ? []
            : [{ control, state: { _tag: "ended", reason } satisfies ComputerUseControlState }],
        ),
        ...shown,
      ];
    },
  };
};
