import { useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";

const INCOMPLETE = "Older work may be missing.";
const FAILED = "Couldn't load older work.";

/**
 * Speaks Home's older-work notices once each time one turns on. The list is virtualized, so a
 * notice entry mounting is no announcement; notices that turn on together are spoken as one, so
 * neither interrupts the other.
 */
export function useMobileHistoryAnnouncements(
  notices: {
    readonly incomplete: boolean;
    readonly failed: boolean;
  } | null,
) {
  const incomplete = notices?.incomplete === true;
  const failed = notices?.failed === true;
  const [seen, setSeen] = useState({ incomplete, failed, seq: 0, text: "" });
  if (seen.incomplete !== incomplete || seen.failed !== failed) {
    const turnedOn = [
      incomplete && !seen.incomplete ? INCOMPLETE : null,
      failed && !seen.failed ? FAILED : null,
    ].filter((line) => line !== null);
    setSeen({
      incomplete,
      failed,
      seq: turnedOn.length > 0 ? seen.seq + 1 : seen.seq,
      text: turnedOn.length > 0 ? turnedOn.join(" ") : seen.text,
    });
  }
  // oxlint-disable-next-line goat/react-effect-budget -- Announces through the platform's screen reader, outside React, once per notice that turned on.
  useEffect(() => {
    if (seen.seq > 0) AccessibilityInfo.announceForAccessibility(seen.text);
  }, [seen.seq, seen.text]);
}
