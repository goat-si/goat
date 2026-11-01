export type DesktopUpdateInstallationReason = "translocated" | "read-only-volume" | "needs-admin";

export function classifyDesktopUpdateInstallation(input: {
  readonly platform: string;
  readonly appBundlePath: string;
  readonly bundleWritable: boolean;
  readonly parentWritable: boolean;
  readonly readOnlyVolume: boolean;
}): DesktopUpdateInstallationReason | null {
  if (input.platform !== "darwin") return null;
  if (input.appBundlePath.includes("/AppTranslocation/")) return "translocated";
  if (input.readOnlyVolume) return "read-only-volume";
  if (!input.bundleWritable || !input.parentWritable) return "needs-admin";
  return null;
}

const SERVER_UPDATE_NOTICE =
  "Servers this app connects to, including this Mac's SSH runtime, still update on their own.";

export function getDesktopUpdateInstallationMessage(
  reason: DesktopUpdateInstallationReason,
): string {
  switch (reason) {
    case "translocated":
      return `GOAT can't update itself while it runs from where it was downloaded. Move GOAT to Applications and reopen it. ${SERVER_UPDATE_NOTICE}`;
    case "read-only-volume":
      return `GOAT can't update itself from a read-only disk. Move GOAT to Applications and reopen it. ${SERVER_UPDATE_NOTICE}`;
    case "needs-admin":
      return `Your account can't write to GOAT or its folder, so installing updates needs an administrator. ${SERVER_UPDATE_NOTICE}`;
  }
}
