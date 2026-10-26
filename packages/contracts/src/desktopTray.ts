/** A thread row in the desktop tray menu. */
export interface DesktopTrayThread {
  readonly environmentId: string;
  readonly threadId: string;
  readonly title: string;
  readonly project: string | null;
}

/** Each thread appears in at most one section, in this order of precedence. */
export interface DesktopTrayMenu {
  readonly attention: readonly DesktopTrayThread[];
  readonly running: readonly DesktopTrayThread[];
  readonly pinned: readonly DesktopTrayThread[];
}

export interface DesktopTrayBridge {
  setTrayMenu?: (menu: DesktopTrayMenu) => Promise<void>;
  onTrayOpenThread?: (
    listener: (thread: Pick<DesktopTrayThread, "environmentId" | "threadId">) => void,
  ) => () => void;
}
