import { useLayoutEffect, useRef, useState } from "react";
import { observeResize } from "../../lib/observeResize";

export function useNoticeCutOff(message: string | null) {
  const labelRef = useRef<HTMLSpanElement>(null);
  const [noticeCutOff, setNoticeCutOff] = useState(false);
  // oxlint-disable-next-line goat/react-effect-budget -- layout determines whether notice text is clipped
  useLayoutEffect(() => {
    const label = labelRef.current;
    if (!label || message === null) return;
    const measure = () => setNoticeCutOff(label.scrollWidth > label.clientWidth);
    measure();
    return observeResize(label, measure);
  }, [message]);
  return { labelRef, noticeCutOff };
}
