// @effect-diagnostics nodeBuiltinImport:off - a mocked CDP session for ServerBrowser tests; no Effect runtime.
import * as NodeEvents from "node:events";
import { vi } from "vite-plus/test";

export type MockFrame = ReturnType<typeof makeFrame>;

/** What the next copy shortcut copies: the page's selection, or the focused frame's. */
export const mockCopy: { page: string; key: string; focusedFrame: MockFrame | null } = {
  page: "",
  key: "",
  focusedFrame: null,
};

function makeFrame() {
  const frame = {
    copy: "",
    detached: false,
    isDetached: () => frame.detached,
    recording: Promise.withResolvers<void>(),
  };
  return frame;
}

const PNG_HEADER = (() => {
  const header = Buffer.alloc(24);
  header.write("IHDR", 12);
  header.writeUInt32BE(1280, 16);
  header.writeUInt32BE(800, 20);
  return header.toString("base64");
})();

export function makeSession(frame?: MockFrame) {
  const events = new NodeEvents.EventEmitter();
  return {
    on: vi.fn((name: string, listener: () => void) => events.on(name, listener)),
    emit: (name: string) => events.emit(name),
    detach: vi.fn(async () => {}),
    send: vi.fn(async (method: string, input?: unknown): Promise<Record<string, unknown>> => {
      if (method === "Page.getNavigationHistory") return { currentIndex: 0, entries: [{}] };
      if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { pageX: 0, pageY: 0 } };
      if (method === "Page.captureScreenshot") {
        // A snapshot sizes its screenshot from the PNG header; viewers get JPEG frames as-is.
        return { data: (input as { format: string }).format === "png" ? PNG_HEADER : "ZnJhbWU=" };
      }
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      // Snapshots read password fields from their own isolated world in each frame.
      if (method === "Page.createIsolatedWorld") {
        return {
          executionContextId:
            (input as { worldName?: string }).worldName === "goat-preview"
              ? 1
              : (input as { worldName?: string }).worldName === "goat-preview-metrics"
                ? 8
                : 7,
        };
      }
      if (method === "Runtime.evaluate" && (input as { contextId?: number }).contextId === 1) {
        return { result: { value: [] } };
      }
      if (method === "Runtime.evaluate" && (input as { contextId?: number }).contextId === 8) {
        return { result: { value: { ratio: 1, width: 1280, height: 800 } } };
      }
      if (method === "Page.addScriptToEvaluateOnNewDocument") frame?.recording.resolve();
      if (method === "Input.dispatchKeyEvent" && (input as { commands?: unknown }).commands) {
        if (mockCopy.focusedFrame)
          mockCopy.focusedFrame.copy = mockCopy.key || mockCopy.focusedFrame.copy;
        else mockCopy.page = mockCopy.key || mockCopy.page;
      }
      if (method === "Runtime.evaluate" && (input as { contextId?: number }).contextId === 7) {
        const value = frame ? frame.copy : mockCopy.page;
        if (frame) frame.copy = "";
        else mockCopy.page = "";
        return { result: { value } };
      }
      return { result: { value: "evaluated" } };
    }),
  };
}
