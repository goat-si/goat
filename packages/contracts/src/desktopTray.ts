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
  /** Computer use on the window's own computer; absent or null while no agent holds it. */
  readonly computerUse?: DesktopTrayComputerUse | null;
}

/** One app, or the whole screen, that agents on this computer control now. */
interface DesktopTrayComputerUseTarget {
  /** A scope id as the server reports it; null for the whole screen. */
  readonly appId: string | null;
  readonly name: string;
  /** A PNG data URL, when the desktop could read the app's icon. */
  readonly icon: string | null;
  /** Threads holding it now, at most 1000 for display. A click re-resolves them all. */
  readonly threadCount: number;
}

interface DesktopTrayComputerUse {
  readonly threadCount: number;
  /** Every app held, including any past the listed targets. */
  readonly appCount: number;
  readonly targets: readonly DesktopTrayComputerUseTarget[];
}

/** What a tray pick asks the renderer to do. */
type DesktopTrayAction =
  | ({ readonly kind: "open-thread" } & Pick<DesktopTrayThread, "environmentId" | "threadId">)
  | { readonly kind: "new-thread" }
  /** appId null: the whole screen. The renderer stops every live holder at click time. */
  | { readonly kind: "stop-computer-use"; readonly appId: string | null }
  | { readonly kind: "stop-all-computer-use" };

export interface DesktopTrayBridge {
  setTrayMenu?: (menu: DesktopTrayMenu) => Promise<void>;
  onTrayAction?: (listener: (action: DesktopTrayAction) => void) => () => void;
}
