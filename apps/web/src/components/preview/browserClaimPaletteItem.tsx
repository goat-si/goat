import { MonitorIcon } from "~/components/solar";
import { dispatchMenuAction } from "~/shortcuts/dispatcher";

export function browserClaimPaletteItem() {
  return {
    kind: "action" as const,
    value: "action:browser-claim",
    searchTerms: ["browser", "tab", "claim"],
    title: "Let GOAT use a browser tab",
    icon: <MonitorIcon className="size-4 text-icon-muted" />,
    run: async () => dispatchMenuAction("browser.claim"),
  };
}
