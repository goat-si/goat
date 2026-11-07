import { useDesktopUpdateState } from "~/state/desktopUpdate";
import { resolveLocalVersionStatusLabel } from "./ConnectionsSettings.logic";

export const ADVANCED_CONNECTION_SETTING_IDS = [
  "hosts",
  "provider-host-matrix",
  "cloud-machines",
  "remote-launches",
  "load-balancing",
  "github-routing",
] as const;

export function LocalVersionStatusLabel() {
  const updateState = useDesktopUpdateState();
  return (
    <span className="text-xs text-muted-foreground">
      {resolveLocalVersionStatusLabel(updateState)}
    </span>
  );
}
