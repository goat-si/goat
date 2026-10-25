/**
 * Stopped cards that outlive their control. A turn whose attachment was under way when a person
 * pressed Stop mints a newer control for the thread afterwards; the stopped card stays listed as
 * stopped beside it until the person closes it (#1521). One per thread, the latest stopped.
 *
 * @module ComputerUseStoppedCards
 */
import type { ComputerUseControlEnd, ThreadId } from "@goat/contracts";

import type { ComputerUseControl, ComputerUseControlState } from "./ComputerUseControl.ts";

type Stopped = Extract<ComputerUseControlEnd, "stopped" | "stopped_all">;

export const makeStoppedCards = () => {
  const byThread = new Map<
    ThreadId,
    { readonly control: ComputerUseControl; readonly reason: Stopped }
  >();
  return {
    /** Keeps a control a newer one replaces, when a person stopped it. */
    replaced: (
      control: ComputerUseControl & { readonly ended?: ComputerUseControlEnd | undefined },
    ) => {
      if (control.ended === "stopped" || control.ended === "stopped_all")
        byThread.set(control.threadId, { control, reason: control.ended });
    },
    /** The kept cards as session list entries. */
    list: () =>
      Array.from(byThread.values(), ({ control, reason }) => ({
        control,
        state: { _tag: "ended", reason } satisfies ComputerUseControlState,
      })),
  };
};
