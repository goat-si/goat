import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, HostDiskPressure } from "@goat/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { useClientSettings } from "../hooks/useSettings";
import { formatBytes } from "../lib/formatBytes";
import { useEnvironment, useEnvironmentIdentities } from "../state/environments";
import { serverEnvironment } from "../state/server";
import { hasDesktopNotifications } from "../threadNotifications";
import {
  announcedAfter,
  diskPressureNotice,
  diskPressureStorageKey,
  parseAnnouncedLevel,
} from "./diskPressureNotifications.logic";
import { toastManager } from "./ui/toast";

/**
 * Tells the person when a machine's disk gets low, once per rise in level, with a way to free
 * space. Servers that predate the disk stream are not asked.
 */
export function DiskPressureNotificationCoordinator() {
  const identities = useEnvironmentIdentities();
  return identities.map(({ environmentId, label }) => (
    <EnvironmentDiskNotice key={environmentId} environmentId={environmentId} label={label} />
  ));
}

function EnvironmentDiskNotice(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const environment = useEnvironment(props.environmentId);
  if (environment?.serverConfig?.environment.capabilities.storageUsage !== true) return null;
  return <DiskNotice {...props} />;
}

const readAnnounced = (key: string) => {
  try {
    return parseAnnouncedLevel(window.localStorage.getItem(key));
  } catch {
    return null;
  }
};
const writeAnnounced = (key: string, level: string) => {
  try {
    window.localStorage.setItem(key, level);
  } catch {
    // Without storage a reload may repeat one notice; nothing else depends on it.
  }
};

function DiskNotice(props: { readonly environmentId: EnvironmentId; readonly label: string }) {
  const reading = useAtomValue(
    serverEnvironment.diskPressure({ environmentId: props.environmentId, input: {} }),
  );
  const value: HostDiskPressure | null = reading._tag === "Success" ? reading.value : null;
  const level = value?.level ?? null;
  const mode = useClientSettings((settings) => settings.notificationMode);
  const inApp = useClientSettings((settings) => settings.inAppNotificationsEnabled);
  const navigate = useNavigate();

  useEffect(() => {
    if (value === null || level === null) return;
    const key = diskPressureStorageKey(props.environmentId);
    const title =
      level === "critical"
        ? props.label + " is almost out of disk space"
        : props.label + " is low on disk space";
    const body =
      formatBytes(value.availableBytes) +
      " free of " +
      formatBytes(value.totalBytes) +
      ". Settings > Storage shows what GOAT can clean up.";
    const open = () =>
      void navigate({ to: "/settings/storage", search: { machine: props.environmentId } });
    /** Whether the person was shown the warning. */
    const present = () => {
      if (inApp && document.visibilityState === "visible" && document.hasFocus()) {
        const toastId = toastManager.add({
          type: level === "critical" ? "error" : "warning",
          title,
          description: body,
          data: { hideCopyButton: true },
          actionProps: {
            children: "Free up space",
            onClick: () => {
              toastManager.close(toastId);
              open();
            },
          },
        });
        return true;
      }
      if (
        !hasDesktopNotifications(mode) ||
        typeof Notification === "undefined" ||
        Notification.permission !== "granted"
      )
        return false;
      try {
        const notification = new Notification(title, {
          body,
          tag: "disk:" + props.environmentId,
          silent: true,
        });
        notification.addEventListener("click", () => {
          notification.close();
          window.focus();
          void window.desktopBridge?.revealWindow?.().catch(() => undefined);
          open();
        });
        return true;
      } catch {
        // Some browsers expose Notification but reject desktop presentation.
        return false;
      }
    };
    const attempt = () => {
      const notice = diskPressureNotice(readAnnounced(key), level);
      const next = announcedAfter(notice, notice.notify && present());
      if (next !== null) writeAnnounced(key, next);
    };
    attempt();
    // A warning nobody could be shown is tried again when the page is seen again.
    window.addEventListener("focus", attempt);
    document.addEventListener("visibilitychange", attempt);
    return () => {
      window.removeEventListener("focus", attempt);
      document.removeEventListener("visibilitychange", attempt);
    };
    // Reruns as free space changes are harmless: the stored level keeps a notice from repeating.
  }, [level, value, props.environmentId, props.label, inApp, mode, navigate]);

  return null;
}
