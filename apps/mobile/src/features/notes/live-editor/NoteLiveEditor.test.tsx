import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const page = vi.hoisted(() => ({
  posted: [] as unknown[],
  onMessage: null as null | ((event: { nativeEvent: { data: string } }) => void),
}));
vi.mock("./note-editor-asset", () => ({
  loadEditorUri: async () => "file:///editor/index.html",
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children?: unknown }) => children,
  Platform: { OS: "ios" },
  useWindowDimensions: () => ({ fontScale: 1 }),
}));
vi.mock("react-native-webview", async () => {
  const { useImperativeHandle } = await import("react");
  return {
    WebView: (props: {
      ref?: unknown;
      onMessage: (event: { nativeEvent: { data: string } }) => void;
    }) => {
      useImperativeHandle(props.ref as never, () => ({
        postMessage: (data: string) => page.posted.push(JSON.parse(data)),
      }));
      page.onMessage = props.onMessage;
      return null;
    },
  };
});
vi.mock("../../../components/ui/AppActivityIndicator", () => ({
  AppActivityIndicator: () => null,
}));
vi.mock("../../settings/appearance/AppearancePreferencesProvider", () => ({}));
vi.mock("../../../lib/appearancePreferences", () => ({}));
vi.mock("../useNoteFiles", () => ({ useNoteImageResolver: () => () => {} }));

const { NoteLiveEditor } = await import("./NoteLiveEditor");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function editor(editable: boolean) {
  return (
    <NoteLiveEditor
      value=""
      lineBreak={"\n"}
      autoFocus
      config={{ editable, readOnly: false, theme: {} as never }}
      environmentId={"hub" as never}
      notePath="new.md"
      onChange={() => {}}
      onFocusChange={() => {}}
      onSourceChange={() => {}}
      onLink={() => {}}
      onUnavailable={() => {}}
      onPendingChange={() => {}}
      onRecoveryLost={() => {}}
    />
  );
}

const focusCommands = () =>
  page.posted.filter(
    (message) =>
      (message as { type: string; command?: string }).type === "command" &&
      (message as { command: string }).command === "focus",
  );

it("focuses a new note once its page can take the keyboard, even if access arrives after the page", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(editor(false)));
  act(() =>
    page.onMessage?.({ nativeEvent: { data: JSON.stringify({ type: "ready", bootMs: 5 }) } }),
  );
  // A page that cannot be edited ignores focus, so sending it now would be lost.
  expect(focusCommands()).toHaveLength(0);

  await act(async () => root.render(editor(true)));
  expect(focusCommands()).toHaveLength(1);
  const config = page.posted.findIndex(
    (message) => (message as { type: string }).type === "config",
  );
  expect(config).toBeGreaterThanOrEqual(0);
  expect(config).toBeLessThan(page.posted.indexOf(focusCommands()[0]));

  await act(async () => root.render(editor(true)));
  expect(focusCommands()).toHaveLength(1);
  act(() => root.unmount());
});
