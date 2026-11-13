import { useState } from "react";

/**
 * Holds where a sheet's row leads until the sheet has slid away; where the sheet reports no
 * dismissal (Android) it goes at once. The trip is dropped if the screen under the sheet loses
 * focus first.
 */
export function useAfterSheetGone(focused: boolean, reportsDismissal: boolean) {
  const [next, setNext] = useState<{ readonly go: () => void } | null>(null);
  if (next !== null && !focused) setNext(null);
  return {
    hold: (go: () => void) => (reportsDismissal ? setNext({ go }) : go()),
    gone: () => {
      setNext(null);
      next?.go();
    },
  };
}
