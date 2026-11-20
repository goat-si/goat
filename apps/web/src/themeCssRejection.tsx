import { useSyncExternalStore } from "react";
import { useMessages } from "gt-react";
import { THEME_CSS_INVALID_MESSAGE, THEME_CSS_RESOURCE_MESSAGE } from "./themeCssMessages";
let rejected: false | "resource" | "invalid" = false;
const listeners = new Set<() => void>();
export function setThemeCssRejected(value: false | "resource" | "invalid") {
  rejected = value;
  for (const listener of listeners) listener();
}
export function ThemeCssRejectionNotice() {
  const m = useMessages();
  const visible = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => rejected,
    () => false,
  );
  return visible ? (
    <div
      role="alert"
      className="fixed right-4 top-4 z-[100] rounded-md border bg-background p-3 text-sm text-foreground shadow-lg"
    >
      {m(visible === "resource" ? THEME_CSS_RESOURCE_MESSAGE : THEME_CSS_INVALID_MESSAGE)}
    </div>
  ) : null;
}
