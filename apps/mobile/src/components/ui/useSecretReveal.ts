import { useEffect, useState } from "react";
import { AppState } from "react-native";

/**
 * The eye's state for a secret field: masked again on every submit, when the app leaves the
 * foreground and, with `maskOnWindowBlur`, when the window loses focus (Android keeps the app
 * resumed under recents; iOS refuses focus events), so no revealed value outlives an error or
 * shows in the app switcher.
 */
export function useSecretReveal(editable: boolean, maskOnWindowBlur = false) {
  const [revealed, setRevealed] = useState(false);
  if (revealed && !editable) setRevealed(false);
  // oxlint-disable-next-line goat/react-effect-budget -- follows the app's foreground and focus while the value shows
  useEffect(() => {
    if (!revealed) return;
    const subscription = AppState.addEventListener("change", (next) => {
      if (next !== "active") setRevealed(false);
    });
    const blur = maskOnWindowBlur
      ? AppState.addEventListener("blur", () => setRevealed(false))
      : undefined;
    return () => {
      subscription.remove();
      blur?.remove();
    };
  }, [revealed, maskOnWindowBlur]);
  return [revealed, () => setRevealed((current) => !current)] as const;
}
