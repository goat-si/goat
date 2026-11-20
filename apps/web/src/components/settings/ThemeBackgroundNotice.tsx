import { msg, useMessages } from "gt-react";
import { useSyncExternalStore } from "react";
import {
  retryThemeBackground,
  subscribeThemeBackground,
  themeBackgroundStatus,
} from "../../themeBackground";
import { Button } from "../ui/button";

const UNAVAILABLE = msg("The published theme background is unavailable.");
const RETRY = msg("Try again");

export function ThemeBackgroundNotice() {
  const m = useMessages();
  const status = useSyncExternalStore(
    subscribeThemeBackground,
    themeBackgroundStatus,
    () => "idle",
  );
  if (status !== "unavailable") return null;
  return (
    <div role="status">
      <span>{m(UNAVAILABLE)}</span>{" "}
      <Button size="sm" variant="ghost" onClick={retryThemeBackground}>
        {m(RETRY)}
      </Button>
    </div>
  );
}
