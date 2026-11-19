import { T } from "gt-react";
import type { PreviewStreamMouseButton } from "@goat/client-runtime/preview/server-browser-stream";
import { toastManager } from "~/components/ui/toast";

export const buttonOf = (button: number): PreviewStreamMouseButton =>
  button === 0 ? "left" : button === 1 ? "middle" : button === 2 ? "right" : "none";

export const pressedButtonOf = (buttons: number): PreviewStreamMouseButton =>
  buttons & 1 ? "left" : buttons & 2 ? "right" : buttons & 4 ? "middle" : "none";

// Mouse thumb buttons: `button === 3` is Back, `button === 4` is Forward.
export const historyDeltaOf = (button: number): -1 | 1 | null =>
  button === 3 ? -1 : button === 4 ? 1 : null;

/** Browsers may refuse a write that arrives after the key press; a toast button is a fresh gesture. */
export async function copyPageText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const id = toastManager.add({
      type: "info",
      title: "The page copied text",
      actionProps: {
        children: "Copy",
        onClick: () => {
          toastManager.close(id);
          void navigator.clipboard.writeText(text).catch(() => undefined);
        },
      },
    });
  }
}

export function NoFramesMessage() {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-background p-4 text-center">
      <p role="alert" className="max-w-sm text-sm text-muted-foreground">
        <T>
          The server's browser loaded this page but is not drawing it. Try reloading, or open the
          page in a browser on this computer.
        </T>
      </p>
    </div>
  );
}
