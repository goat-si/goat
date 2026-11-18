import { useEffect, useState } from "react";
import { AppState } from "react-native";

/**
 * The eye's state for a secret field. It masks again whenever the field stops being editable
 * (every submit, successful or not) and when the app leaves the foreground, so a revealed value
 * is not left under an error or in the app switcher's snapshot.
 */
export function useSecretReveal(editable: boolean) {
  const [revealed, setRevealed] = useState(false);
  if (revealed && !editable) setRevealed(false);
  // oxlint-disable-next-line goat/react-effect-budget -- follows the app's foreground state while the value shows
  useEffect(() => {
    if (!revealed) return;
    const subscription = AppState.addEventListener("change", (next) => {
      if (next !== "active") setRevealed(false);
    });
    return () => subscription.remove();
  }, [revealed]);
  return [revealed, () => setRevealed((current) => !current)] as const;
}
