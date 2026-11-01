/**
 * Windows processes that host windows for other apps or for the shell. Closing one closes
 * windows a person has open elsewhere, so a harness that opened a window never ends its owner
 * when the owner is one of these (#1247): packaged apps such as Calculator draw inside
 * ApplicationFrameHost.exe, whose pid list_windows reports as the window's owner.
 */
const SHARED_HOST_IMAGES = new Set(
  [
    "ApplicationFrameHost.exe",
    "explorer.exe",
    "dwm.exe",
    "svchost.exe",
    "RuntimeBroker.exe",
    "sihost.exe",
    "ShellExperienceHost.exe",
    "StartMenuExperienceHost.exe",
    "SearchHost.exe",
    "TextInputHost.exe",
    "csrss.exe",
    "winlogon.exe",
    "conhost.exe",
  ].map((image) => image.toLowerCase()),
);

/**
 * The pids a run may end: ones it started and saw start, that are not running a shared host.
 * Anything else is left alone and closed through its own window instead.
 */
export function pidsSafeToClose(
  opened: ReadonlyArray<{ readonly pid: number; readonly image: string }>,
  runningBefore: ReadonlySet<number>,
): ReadonlyArray<number> {
  return opened
    .filter(
      ({ pid, image }) => !runningBefore.has(pid) && !SHARED_HOST_IMAGES.has(image.toLowerCase()),
    )
    .map(({ pid }) => pid);
}
