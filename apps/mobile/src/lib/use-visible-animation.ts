import { useIsFocused } from "@react-navigation/native";
import { useEffect, useState } from "react";
import { AccessibilityInfo, AppState } from "react-native";

/** Retained screens animate only while visible and motion is permitted. */
export function useVisibleAnimation() {
  const focused = useIsFocused();
  const [appActive, setAppActive] = useState(() => AppState.currentState === "active");
  const [reducedMotion, setReducedMotion] = useState(true);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setAppActive(state === "active"),
    );
    // oxlint-disable-next-line react/set-state-in-effect -- Catch changes before the listener was installed.
    setAppActive(AppState.currentState === "active");
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    let current = true;
    let changed = false;
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", (value) => {
      changed = true;
      setReducedMotion(value);
    });
    void AccessibilityInfo.isReduceMotionEnabled().then(
      (value) => {
        if (current && !changed) setReducedMotion(value);
      },
      () => undefined,
    );
    return () => {
      current = false;
      subscription.remove();
    };
  }, []);

  return focused && appActive && !reducedMotion;
}
