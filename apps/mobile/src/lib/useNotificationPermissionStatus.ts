import { reportAtomCommandResult, settlePromise } from "@goat/client-runtime/state/runtime";
import * as Notifications from "expo-notifications";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Platform } from "react-native";

export type NotificationStatus = "checking" | "enabled" | "disabled" | "unsupported";

async function readNotificationStatus(): Promise<NotificationStatus> {
  if (Platform.OS !== "ios" && Platform.OS !== "android") return "unsupported";
  const result = await settlePromise(() => Notifications.getPermissionsAsync());
  if (result._tag === "Failure") {
    reportAtomCommandResult(result, { label: "notification permission refresh" });
    return "disabled";
  }
  return result.value.granted ? "enabled" : "disabled";
}

export function useNotificationPermissionStatus() {
  const [status, setStatus] = useState<NotificationStatus>("checking");
  const revision = useRef(0);
  const setNotificationStatus = useCallback((next: NotificationStatus) => {
    revision.current += 1;
    setStatus(next);
  }, []);
  // oxlint-disable-next-line goat/react-effect-budget -- Observes native permissions on mount and foreground, releasing the native listener on unmount.
  useEffect(() => {
    let mounted = true;
    const refresh = async () => {
      const requested = ++revision.current;
      const next = await readNotificationStatus();
      if (mounted && requested === revision.current) setStatus(next);
    };
    void refresh();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh();
    });
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);
  return [status, setNotificationStatus] as const;
}
