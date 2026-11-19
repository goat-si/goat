import { useState } from "react";
import { Platform } from "react-native";
import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";

function usePullRequestToolbarHeight(bottomInset: number) {
  const { buttonSize } = useAndroidControlSizing();
  return useState(() => (Platform.OS === "android" ? bottomInset + buttonSize + 40 : 0));
}

export { usePullRequestToolbarHeight };
