import {
  EnvironmentId,
  ThreadId,
  type PreviewSession,
  type PreviewSessionFrameEvent,
} from "@goat/contracts";
import { act, useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  sessions: [] as PreviewSession[],
  foreground: "active",
  listeners: new Set<(state: string) => void>(),
  streams: new Set<string>(),
  canControl: true,
  navigate: vi.fn(),
  control: vi.fn(),
  frame: null as PreviewSessionFrameEvent | null,
  frameRequests: [] as Array<string | null>,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => h.canControl }));
vi.mock("@react-navigation/native", () => ({
  useIsFocused: () => true,
  useNavigation: () => ({ navigate: h.navigate }),
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Image: ({
    source,
    style,
  }: {
    source: { uri: string };
    style?: { opacity?: number } | ReadonlyArray<{ opacity?: number } | false | undefined>;
  }) => {
    const styles = Array.isArray(style) ? style : [style];
    const dimmed = styles.some((item) => item && item.opacity !== undefined && item.opacity < 1);
    return <img alt="" src={source.uri} data-dimmed={dimmed || undefined} />;
  },
  Pressable: ({
    children,
    onPress,
    disabled,
  }: {
    children?: ReactNode;
    onPress: () => void;
    disabled?: boolean;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
  FlatList: ({
    data,
    onViewableItemsChanged,
    renderItem,
    ListHeaderComponent,
  }: {
    data: PreviewSession[];
    onViewableItemsChanged: (input: {
      viewableItems: { item: PreviewSession; key: string; isViewable: boolean }[];
    }) => void;
    renderItem: (input: { item: PreviewSession }) => ReactNode;
    ListHeaderComponent: ReactNode;
  }) => {
    useEffect(
      () =>
        onViewableItemsChanged({
          viewableItems: data.map((item) => ({ item, key: item.id, isViewable: true })),
        }),
      [onViewableItemsChanged],
    );
    return (
      <div>
        {ListHeaderComponent}
        {data.map((item) => (
          <div key={item.id}>{renderItem({ item })}</div>
        ))}
      </div>
    );
  },
  Keyboard: { dismiss: () => {} },
  AppState: {
    get currentState() {
      return h.foreground;
    },
    addEventListener: (_event: string, listener: (state: string) => void) => {
      h.listeners.add(listener);
      return { remove: () => h.listeners.delete(listener) };
    },
  },
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({
    label,
    onPress,
    disabled,
  }: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../../components/ui/Sheet", () => ({
  Sheet: ({ children, onClose }: { children: ReactNode; onClose: () => void }) => (
    <div role="dialog">
      <button onClick={onClose}>Close</button>
      {children}
    </div>
  ),
}));
vi.mock("../../state/entities", () => ({ useThreadShell: () => ({ title: "Another thread" }) }));
vi.mock("../../state/previewSessions", () => ({
  usePreviewSessions: () => ({ data: { sessions: h.sessions }, error: null, refresh: () => {} }),
  useDesktopSessionFrame: (_environmentId: string, sessionId: string | null) => {
    h.frameRequests.push(sessionId);
    return { event: sessionId === null ? null : h.frame, failed: false };
  },
  previewSessionsEnvironment: { control: { permissionAtom: () => ({}) } },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => h.control }));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeVariables: { "--color-sheet-solid": "#fff" } }),
}));
vi.mock("./ThreadBrowserFloat", () => ({ ThreadBrowserFloat: () => null }));
vi.mock("./PreviewStreamWebView", () => ({
  PreviewStreamWebView: ({ tabId }: { tabId: string }) => {
    useEffect(() => {
      h.streams.add(tabId);
      return () => {
        h.streams.delete(tabId);
      };
    }, [tabId]);
    return <div role="img" aria-label={tabId} />;
  },
}));

import { ThreadPreviewSessions } from "./ThreadPreviewSessions";

const environmentId = EnvironmentId.make("remote");
const session = (overrides: Partial<PreviewSession> = {}): PreviewSession => ({
  id: "browser",
  kind: "browser",
  environmentId,
  host: "remote-host",
  platform: "linux",
  threadId: ThreadId.make("other-thread"),
  target: { kind: "browser", tabId: "tab", title: "Example", url: "https://example.test/path" },
  owner: "agent",
  status: "acting",
  capabilities: {
    controls: ["takeover", "stop"],
    frames: true,
    privateMode: true,
    humanInput: true,
  },
  ...overrides,
});
function setup(sessions: PreviewSession[]) {
  h.sessions = sessions;
  h.foreground = "active";
  h.canControl = true;
  h.navigate.mockReset();
  h.control.mockReset().mockResolvedValue({ _tag: "Success", value: { applied: true } });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = () =>
    act(() =>
      root.render(
        <ThreadPreviewSessions
          environmentId={environmentId}
          threadId={ThreadId.make("current-thread")}
          tabs={[]}
          loaded
          top={8}
          onOpen={() => {}}
        />,
      ),
    );
  render();
  return {
    container,
    render,
    async click(label: string) {
      const button = [...container.querySelectorAll("button")].find(
        (item) => item.textContent === label,
      );
      expect(button, label).toBeDefined();
      await act(async () => button?.click());
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
      expect(h.streams.size).toBe(0);
      expect(h.listeners.size).toBe(0);
    },
  };
}

it("shows no private pixels and releases all visible streams on background, privacy changes and sheet close", async () => {
  using screen = setup([
    session(),
    session({
      id: "private",
      owner: "private",
      target: { kind: "browser", tabId: "secret", url: "", title: "Private" },
    }),
  ]);
  expect(h.streams.size).toBe(0);
  await screen.click("2 agents on screen");
  expect(h.streams).toEqual(new Set(["tab"]));
  expect(screen.container.textContent).toContain("Private (paused)");
  act(() => {
    for (const listener of h.listeners) listener("inactive");
  });
  expect(h.streams.size).toBe(0);
  act(() => {
    for (const listener of h.listeners) listener("active");
  });
  expect(h.streams).toEqual(new Set(["tab"]));
  h.sessions = h.sessions.map((item) => ({ ...item, owner: "private" }));
  screen.render();
  expect(h.streams.size).toBe(0);
  await screen.click("Close");
  expect(screen.container.querySelector('[role="dialog"]')).toBeNull();
});

it("opens takeover in the session's full browser route, then sends stopped Hand back and Stop all to the environment", async () => {
  using screen = setup([session()]);
  await screen.click("1 agents on screen");
  await screen.click("Take over");
  expect(h.navigate).toHaveBeenCalledWith("ThreadBrowserPreview", {
    environmentId: "remote",
    threadId: "other-thread",
    tabId: "tab",
  });
  expect(h.control).not.toHaveBeenCalled();
  expect(h.streams.size).toBe(0);
  h.sessions = [
    session({
      status: "stopped",
      capabilities: {
        controls: ["handBack", "stop"],
        frames: false,
        privateMode: true,
        humanInput: true,
      },
    }),
  ];
  screen.render();
  await screen.click("1 agents on screen");
  await screen.click("Hand back");
  expect(h.control).toHaveBeenLastCalledWith({
    environmentId,
    input: { sessionId: "browser", control: "handBack" },
  });
  await screen.click("Stop");
  expect(h.control).toHaveBeenLastCalledWith({
    environmentId,
    input: { sessionId: "browser", control: "stop" },
  });
  await screen.click("Stop all");
  expect(h.control).toHaveBeenLastCalledWith({ environmentId, input: { control: "stopAll" } });
});

it("keeps denied controls disabled and surfaces an unapplied desktop control", async () => {
  using screen = setup([
    session({ id: "desktop", kind: "desktop", target: { kind: "desktop", title: "Editor" } }),
  ]);
  h.canControl = false;
  screen.render();
  await screen.click("1 agents on screen");
  await screen.click("Stop all");
  expect(h.control).not.toHaveBeenCalled();
  h.canControl = true;
  screen.render();
  h.control.mockResolvedValue({
    _tag: "Success",
    value: { applied: false, reason: "not_allowed" },
  });
  await screen.click("Take over");
  expect(h.control).toHaveBeenCalledWith({
    environmentId,
    input: { sessionId: "desktop", control: "takeover" },
  });
  expect(screen.container.textContent).toContain("does not allow that control");
  expect(h.navigate).not.toHaveBeenCalled();
});

it("uses the existing stream backpressure for 2 fps thumbnails and sends no late ACK after teardown", async () => {
  const viewer = await import("./preview-stream.browser");
  const sockets: Socket[] = [];
  class Socket extends EventTarget {
    static readonly OPEN = 1;
    readyState = 1;
    binaryType = "";
    readonly sent: string[] = [];
    constructor(readonly url: string) {
      super();
      sockets.push(this);
    }
    send(message: string) {
      this.sent.push(message);
    }
    close() {
      this.readyState = 3;
    }
    frame() {
      this.dispatchEvent(new MessageEvent("message", { data: new ArrayBuffer(3) }));
    }
  }
  vi.useFakeTimers();
  using _rect = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockReturnValue(DOMRect.fromRect({ width: 320, height: 200 }));
  using _context = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("ReactNativeWebView", { postMessage: vi.fn() });
  vi.stubGlobal("createImageBitmap", async () => ({ width: 480, height: 300, close: () => {} }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(readonly callback: () => void) {}
      observe() {
        this.callback();
      }
      disconnect() {}
    },
  );
  try {
    viewer.start({
      access: {
        httpBase: "https://remote.test/api/preview-stream",
        wsBase: "wss://remote.test/api/preview-stream",
        query: { wsTicket: "test-ticket" },
        credentials: false,
      },
      threadId: "other-thread",
      tabId: "tab",
      interactive: false,
      background: "#fff",
      thumbnail: true,
    });
    await vi.advanceTimersByTimeAsync(0);
    const socket = sockets[0];
    expect(socket).toBeDefined();
    if (!socket) throw new Error("Viewer did not connect");
    const query = new URL(socket.url).searchParams;
    expect(Object.fromEntries(query)).toMatchObject({
      threadId: "other-thread",
      tabId: "tab",
      maxWidth: "480",
      maxHeight: "300",
      interactive: "false",
      wsTicket: "test-ticket",
    });
    socket.frame();
    await vi.advanceTimersByTimeAsync(499);
    expect(socket.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.sent).toEqual(['{"type":"ack"}']);
    socket.frame();
    viewer.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(socket.readyState).toBe(3);
    expect(socket.sent).toEqual(['{"type":"ack"}']);
  } finally {
    viewer.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

// As on web (#1330): while a person controls a tab, other viewers' cards do not watch them.
it("streams no picture of a tab a person has taken over", async () => {
  using screen = setup([session({ owner: "human", status: "paused" })]);
  await screen.click("1 agents on screen");
  expect(h.streams.size).toBe(0);
  expect(screen.container.textContent).toContain("A person is in control");
});

const desktop = (overrides: Partial<PreviewSession> = {}): PreviewSession =>
  session({
    id: "desktop:control:1",
    kind: "desktop",
    target: { kind: "desktop", title: "fixture.exe" },
    capabilities: { controls: ["stop"], frames: true, privateMode: true, humanInput: true },
    ...overrides,
  });
const jpeg = (data: string): PreviewSessionFrameEvent => ({
  type: "frame",
  seq: 1,
  width: 4,
  height: 4,
  mime: "image/jpeg",
  data,
});

// #1576: the desktop card watches the session's frames through the shared subscription, as web does.
it("shows a desktop session's live frame, nothing in private mode, and the last one dimmed once stopped", async () => {
  h.frame = jpeg("AAAA");
  h.frameRequests = [];
  using screen = setup([desktop()]);
  await screen.click("1 agents on screen");
  const picture = () => screen.container.querySelector("img");
  expect(h.frameRequests.at(-1)).toBe("desktop:control:1");
  expect(picture()?.getAttribute("src")).toBe("data:image/jpeg;base64,AAAA");
  h.frame = { type: "unavailable", reason: "private" };
  screen.render();
  expect(picture()).toBeNull();
  expect(screen.container.textContent).toContain("Private");
  h.frame = jpeg("BBBB");
  screen.render();
  // Stopped: nothing is watched any more, and the last frame stays, dimmed.
  h.sessions = [
    desktop({
      status: "stopped",
      capabilities: { ...desktop().capabilities, controls: ["stopAll"] },
    }),
  ];
  screen.render();
  expect(h.frameRequests.at(-1)).toBeNull();
  expect(picture()?.getAttribute("src")).toBe("data:image/jpeg;base64,BBBB");
  expect(picture()?.hasAttribute("data-dimmed")).toBe(true);
});

it("tells a turn without computer use which grant to allow, and watches no picture", async () => {
  h.frame = jpeg("AAAA");
  h.frameRequests = [];
  using screen = setup([
    desktop({
      status: "permission-needed",
      reason: "permissionsNotGranted",
      target: {
        kind: "desktop",
        title: "Allow Screen & System Audio Recording for GOAT Computer Use",
      },
    }),
  ]);
  await screen.click("1 agents on screen");
  expect(screen.container.textContent).toContain(
    "No computer use yet. Allow Screen & System Audio Recording for GOAT Computer Use (System Settings > Privacy & Security).",
  );
  expect(h.frameRequests.filter((id) => id !== null)).toEqual([]);
});
