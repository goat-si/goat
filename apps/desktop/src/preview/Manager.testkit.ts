import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

export interface TestCapturedPreviewImage {
  readonly toJPEG: () => Buffer;
  readonly toBitmap?: () => Buffer;
  readonly getSize: () => { readonly width: number; readonly height: number };
}

type TestDisplayMediaHandler = (
  request: { readonly frame: { readonly frameTreeNodeId: number } | null },
  callback: (streams: { video?: unknown }) => void,
) => void;

interface TestHostWebContents {
  readonly id: number;
  readonly mainFrame: { readonly frameTreeNodeId: number };
  readonly executeJavaScript: ReturnType<typeof vi.fn>;
  readonly isDestroyed: () => boolean;
  readonly session: {
    readonly setDisplayMediaRequestHandler: ReturnType<typeof vi.fn>;
  };
  readonly displayMediaHandler: () => TestDisplayMediaHandler | undefined;
}

type TestPreviewWebContents = Electron.WebContents & {
  readonly setBackgroundThrottling: ReturnType<typeof vi.fn<(enabled: boolean) => void>>;
};

export const makeTestHostWebContents = (): TestHostWebContents => {
  let handler: TestDisplayMediaHandler | undefined;
  return {
    id: 7,
    mainFrame: { frameTreeNodeId: 7 },
    executeJavaScript: vi.fn(async () => true),
    isDestroyed: () => false,
    session: {
      setDisplayMediaRequestHandler: vi.fn((next: TestDisplayMediaHandler) => {
        handler = next;
      }),
    },
    displayMediaHandler: () => handler,
  };
};

export const makeTestPreviewWebContents =
  (webviewSend: Electron.WebContents["send"]) =>
  (
    capturePage: () => Promise<TestCapturedPreviewImage>,
    id = 42,
    hostWebContents: TestHostWebContents = makeTestHostWebContents(),
  ) => {
    const setBackgroundThrottling = vi.fn<(enabled: boolean) => void>();
    return {
      id,
      mainFrame: { routingId: id },
      hostWebContents,
      executeJavaScript: vi.fn(async () => ({ width: 1280, height: 720 })),
      isDestroyed: () => false,
      getType: () => "webview",
      getURL: () => "https://example.com",
      getTitle: () => "Example",
      isLoadingMainFrame: () => false,
      isDevToolsOpened: () => false,
      reload: vi.fn(),
      loadURL: vi.fn(async () => undefined),
      getZoomFactor: () => 1,
      setZoomFactor: vi.fn(),
      setAudioMuted: vi.fn(),
      setBackgroundThrottling,
      isCurrentlyAudible: () => false,
      on: vi.fn(),
      off: vi.fn(),
      ipc: { on: vi.fn(), off: vi.fn() },
      send: webviewSend,
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      setIgnoreMenuShortcuts: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      debugger: {
        isAttached: () => false,
        attach: vi.fn(),
        sendCommand: vi.fn(async () => undefined),
        on: vi.fn(),
        off: vi.fn(),
      },
      capturePage,
    } as unknown as TestPreviewWebContents;
  };

export const unusedCapture = async (): Promise<TestCapturedPreviewImage> => {
  throw new Error("This test captures no page.");
};

const TEST_FAVICON = "data:image/png;base64,cG5n";

export const makeSourcePng = (width = 1, height = 1): Buffer => {
  const buffer = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
};

export const makeFaviconWebContents =
  (webviewSend: Electron.WebContents["send"]) =>
  (options?: {
    readonly changes?: ChangeSignal;
    readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>;
    readonly id?: number;
    readonly rasterize?: (code: string) => Promise<unknown>;
    readonly url?: string;
  }) => {
    const sourcePng = makeSourcePng();
    const listeners = new Map<string, (...args: never[]) => void>();
    let currentUrl = options?.url ?? "http://localhost:3200/";
    let destroyed = false;
    let loading = false;
    const fetchImpl =
      options?.fetch ??
      (async () =>
        new Response(new Uint8Array(sourcePng), {
          headers: { "content-type": "image/png" },
        }));
    const fetch = vi.fn((url: string, init?: RequestInit) => {
      const response = fetchImpl(url, init);
      options?.changes?.notify();
      return response;
    });
    const executeJavaScriptInIsolatedWorld = vi.fn(
      (_worldId: number, scripts: ReadonlyArray<{ readonly code: string }>) => {
        const result = options?.rasterize
          ? options.rasterize(scripts[0]?.code ?? "")
          : Promise.resolve(TEST_FAVICON);
        options?.changes?.notify();
        return result;
      },
    );
    const reload = vi.fn();
    const loadURL = vi.fn(async (url: string) => {
      currentUrl = url;
    });
    const off = vi.fn();
    const debuggerOff = vi.fn();
    const webContents = {
      id: options?.id ?? 42,
      isDestroyed: () => destroyed,
      getType: () => "webview",
      getURL: () => currentUrl,
      getTitle: () => "Preview",
      isLoadingMainFrame: () => loading,
      isDevToolsOpened: () => false,
      getZoomFactor: () => 1,
      setZoomFactor: vi.fn(),
      setAudioMuted: vi.fn(),
      isCurrentlyAudible: () => false,
      reload,
      reloadIgnoringCache: vi.fn(),
      loadURL,
      on: vi.fn((event: string, listener: (...args: never[]) => void) => {
        listeners.set(event, listener);
      }),
      off,
      ipc: { on: vi.fn(), off: vi.fn() },
      send: webviewSend,
      session: { fetch },
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      isFocused: vi.fn(() => true),
      focusedFrame: {} as object | null,
      setIgnoreMenuShortcuts: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      executeJavaScriptInIsolatedWorld,
      debugger: {
        isAttached: () => false,
        attach: vi.fn(),
        sendCommand: vi.fn(async () => undefined),
        on: vi.fn(),
        off: debuggerOff,
      },
    };
    return {
      executeJavaScriptInIsolatedWorld,
      fetch,
      debuggerOff,
      listeners,
      loadURL,
      off,
      reload,
      setDestroyed: (value: boolean) => {
        destroyed = value;
      },
      setLoading: (value: boolean) => {
        loading = value;
      },
      setUrl: (url: string) => {
        currentUrl = url;
      },
      webContents: webContents as never,
    };
  };

// Electron mocks and state subscribers call `notify`, so a wait re-checks its
// predicate exactly when the state it reads changes.
export const makeChangeSignal = () => {
  const waiters = new Set<() => void>();
  return {
    notify: () => {
      for (const wake of waiters) wake();
    },
    until: (predicate: () => boolean) =>
      Effect.callback<void>((resume) => {
        if (predicate()) return resume(Effect.void);
        const wake = () => {
          if (!predicate()) return;
          waiters.delete(wake);
          resume(Effect.void);
        };
        waiters.add(wake);
        return Effect.sync(() => void waiters.delete(wake));
      }),
  };
};
type ChangeSignal = ReturnType<typeof makeChangeSignal>;

// Favicon captures run detached from the Electron listener, so asserting that
// one published nothing can only give its promise chain a fixed number of turns.
export const flushMicrotasks = function* () {
  for (let turn = 0; turn < 30; turn++) yield* Effect.promise(() => Promise.resolve());
};

export const makeTestPictureInPictureWindow = (
  loadURL: () => Promise<void> = async () => undefined,
) => {
  const listeners = new Map<string, () => void>();
  const webContentsListeners = new Map<string, () => void>();
  const send = vi.fn();
  let destroyed = false;
  const webContents = {
    on: vi.fn((event: string, listener: () => void) => {
      webContentsListeners.set(event, listener);
    }),
    off: vi.fn((event: string) => {
      webContentsListeners.delete(event);
    }),
    send,
  };
  const pictureInPictureWindow = {
    isDestroyed: vi.fn(() => destroyed),
    once: vi.fn((event: string, listener: () => void) => {
      listeners.set(event, listener);
    }),
    setAlwaysOnTop: vi.fn(),
    setVisibleOnAllWorkspaces: vi.fn(),
    setAspectRatio: vi.fn(),
    getContentSize: vi.fn(() => [480, 320]),
    setContentSize: vi.fn(),
    loadURL: vi.fn(loadURL),
    showInactive: vi.fn(() => {
      if (destroyed) throw new Error("Picture-in-picture window is closed.");
    }),
    close: vi.fn(() => {
      if (destroyed) return;
      destroyed = true;
      listeners.get("closed")?.();
    }),
    get webContents() {
      if (destroyed) throw new Error("Picture-in-picture window is closed.");
      return webContents;
    },
  };
  return { pictureInPictureWindow, send, webContentsListeners };
};
