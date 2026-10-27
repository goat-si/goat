/** A thread row in the desktop tray menu. */
interface DesktopTrayThread {
  readonly environmentId: string;
  readonly threadId: string;
  readonly title: string;
  readonly project: string | null;
}

/** Each thread appears in at most one section, in this order of precedence. */
interface DesktopTrayMenu {
  readonly attention: readonly DesktopTrayThread[];
  readonly running: readonly DesktopTrayThread[];
  readonly pinned: readonly DesktopTrayThread[];
}

/** What a tray pick asks the renderer to do. */
type DesktopTrayAction =
  | ({ readonly kind: "open-thread" } & Pick<DesktopTrayThread, "environmentId" | "threadId">)
  | { readonly kind: "new-thread" };

export interface DesktopTrayBridge {
  setTrayMenu?: (menu: DesktopTrayMenu) => Promise<void>;
  onTrayAction?: (listener: (action: DesktopTrayAction) => void) => () => void;
}
