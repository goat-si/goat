import { useEffect, useState } from "react";
import { AppState } from "react-native";

/**
 * The eye's state for a secret field. It masks again whenever the field stops being editable
 * (every submit, successful or not), when the app leaves the foreground and when its window
 * loses focus (Android keeps the app resumed under its recents view), so a revealed value is not
 * left under an error or in the app switcher.
 */
export function useSecretReveal(editable: boolean) {
  const [revealed, setRevealed] = useState(false);
  if (revealed && !editable) setRevealed(false);
  // oxlint-disable-next-line goat/react-effect-budget -- follows the app's foreground and focus while the value shows
  useEffect(() => {
    if (!revealed) return;
    const subscription = AppState.addEventListener("change", (next) => {
      if (next !== "active") setRevealed(false);
    });
    const blur = AppState.addEventListener("blur", () => setRevealed(false));
    return () => {
      subscription.remove();
      blur.remove();
    };
  }, [revealed]);
  return [revealed, () => setRevealed((current) => !current)] as const;
}
