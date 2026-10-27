/** What closing the main window does while GOAT has a tray icon. */
export type CloseOutcome = "close" | "hide" | "probe";

export interface CloseContext {
  readonly platform: NodeJS.Platform;
  readonly iconShown: boolean;
  readonly quitting: boolean;
  /** Windows committed to logging off or shutting down. */
  readonly sessionEnding: boolean;
}

// macOS keeps running windowless already. Linux needs a panel that draws the icon, or the hidden
// window would have no way back, so it asks the session bus first.
export function closeOutcome(context: CloseContext): CloseOutcome {
  if (context.platform === "darwin") return "close";
  if (!context.iconShown || context.quitting || context.sessionEnding) return "close";
  return context.platform === "linux" ? "probe" : "hide";
}

export interface ClosableWindow {
  readonly on: (event: "close", listener: (event: { preventDefault(): void }) => void) => unknown;
  readonly isDestroyed: () => boolean;
  readonly hide: () => void;
  readonly close: () => void;
}

/** Turns closing `window` into hiding it while the tray can bring it back. */
export function attachCloseToTray(
  window: ClosableWindow,
  options: {
    readonly context: () => CloseContext;
    readonly hostAvailable: () => Promise<boolean>;
  },
): void {
  let allowOnce = false;
  let probing = false;
  const closeForReal = () => {
    allowOnce = true;
    window.close();
  };
  window.on("close", (event) => {
    if (allowOnce) {
      allowOnce = false;
      return;
    }
    const outcome = closeOutcome(options.context());
    if (outcome === "close") return;
    event.preventDefault();
    if (outcome === "hide") {
      window.hide();
      return;
    }
    if (probing) return;
    probing = true;
    void options.hostAvailable().then((available) => {
      probing = false;
      if (window.isDestroyed()) return;
      // A quit that began while the bus answered closes the window itself.
      if (closeOutcome(options.context()) === "close") return;
      if (available) window.hide();
      else closeForReal();
    });
  });
}

export interface WatcherBus {
  readonly onError: (listener: (cause: unknown) => void) => void;
  /** The raw IsStatusNotifierHostRegistered property value. */
  readonly hostRegistered: () => Promise<unknown>;
  readonly disconnect: () => void;
}

const PROBE_DEADLINE_MS = 750;

/**
 * Whether a panel on the session bus draws StatusNotifier icons. Stock GNOME has the watcher
 * only with the AppIndicator extension; any failure counts as no.
 */
export async function statusNotifierHostAvailable(
  openBus: () => Promise<WatcherBus>,
  deadlineMs = PROBE_DEADLINE_MS,
): Promise<boolean> {
  let bus: WatcherBus | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<boolean>((resolve) => {
      // @effect-diagnostics-next-line globalTimers:off - Plain promise code around dbus-next.
      timer = setTimeout(() => resolve(false), deadlineMs);
      openBus().then(
        (opened) => {
          bus = opened;
          opened.onError(() => resolve(false));
          opened.hostRegistered().then(
            (value) => resolve(value === true),
            () => resolve(false),
          );
        },
        () => resolve(false),
      );
    });
  } finally {
    clearTimeout(timer);
    try {
      (bus as WatcherBus | null)?.disconnect();
    } catch {
      // The connection already failed.
    }
  }
}

const WATCHER = "org.kde.StatusNotifierWatcher";

export async function openSessionWatcherBus(): Promise<WatcherBus> {
  const dbus = await import("dbus-next");
  const bus = dbus.sessionBus();
  // A connection failure arrives as an `error` event; unhandled, it would crash the main process.
  const listeners: Array<(cause: unknown) => void> = [];
  bus.on("error", (cause: unknown) => {
    for (const listener of listeners) listener(cause);
  });
  return {
    onError: (listener) => listeners.push(listener),
    hostRegistered: async () => {
      const reply = await bus.call(
        new dbus.Message({
          destination: WATCHER,
          path: "/StatusNotifierWatcher",
          interface: "org.freedesktop.DBus.Properties",
          member: "Get",
          signature: "ss",
          body: [WATCHER, "IsStatusNotifierHostRegistered"],
        }),
      );
      const variant: unknown = reply?.body?.[0];
      return typeof variant === "object" && variant !== null && "value" in variant
        ? variant.value
        : undefined;
    },
    disconnect: () => bus.disconnect(),
  };
}
