import { useEffect, useRef, useState } from "react";

/**
 * Holds where a sheet's row leads until the sheet has slid away; where the sheet reports no
 * dismissal (Android) it goes at once. The trip belongs to the scope it was held in and is dropped
 * when that scope changes, the screen under the sheet loses focus, or the screen unmounts.
 */
export function useAfterSheetGone(focused: boolean, reportsDismissal: boolean, scope: string) {
  const [heldIn, setHeldIn] = useState<string | null>(null);
  if (heldIn !== null && (!focused || heldIn !== scope)) setHeldIn(null);
  // Taken synchronously, so a dismissal reported twice goes once.
  const trip = useRef<(() => void) | null>(null);
  // oxlint-disable-next-line goat/react-effect-budget -- A dismissal reported after the screen has gone must not navigate from it.
  useEffect(
    () => () => {
      trip.current = null;
    },
    [],
  );
  return {
    hold: (go: () => void) => {
      if (!reportsDismissal) return go();
      trip.current = go;
      setHeldIn(scope);
    },
    gone: () => {
      const go = trip.current;
      trip.current = null;
      if (heldIn === null || go === null) return;
      setHeldIn(null);
      go();
    },
  };
}
