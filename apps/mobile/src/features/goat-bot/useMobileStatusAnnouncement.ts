import { useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";

/**
 * Speaks a status line once each time it changes to something to say; `null` is silent, such as
 * while a read is out. A line that comes back after a silent spell is spoken again.
 */
export function useMobileStatusAnnouncement(text: string | null) {
  const [seen, setSeen] = useState({ text, seq: 0 });
  if (seen.text !== text) setSeen({ text, seq: text === null ? seen.seq : seen.seq + 1 });
  // oxlint-disable-next-line goat/react-effect-budget -- Announces through the platform's screen reader, outside React, once per change.
  useEffect(() => {
    if (seen.seq > 0 && seen.text !== null) AccessibilityInfo.announceForAccessibility(seen.text);
  }, [seen.seq, seen.text]);
}
