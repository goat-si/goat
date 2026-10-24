import { DEFAULT_RESOLVED_KEYBINDINGS } from "@goat/shared/keybindings";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

const state = vi.hoisted(() => ({ threadFind: vi.fn() }));

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: ((atom: unknown) =>
    atom === "keybindings" ? DEFAULT_RESOLVED_KEYBINDINGS : undefined) as never,
}));
vi.mock(
  import("~/state/server"),
  async (original) =>
    ({
      ...(await original()),
      primaryServerKeybindingsAtom: "keybindings",
      serverEnvironment: { configValueAtom: () => "environment" },
    }) as never,
);
vi.mock("~/hooks/useHtmlRenderTheme", async () => {
  const { htmlRenderTheme } = await import("@goat/shared/htmlRender");
  const { getStandardThemeColors } = await import("~/themePalette");
  const theme = htmlRenderTheme(getStandardThemeColors("dark"), "dark");
  return { useHtmlRenderTheme: () => theme };
});
vi.mock("~/browser/useOpenLink", () => ({ useOpenLink: () => vi.fn() }));
vi.mock("~/lib/openPullRequestLink", () => ({ useOpenChangeRequestLink: () => vi.fn() }));

import { useChatShortcuts } from "~/components/chat/useChatShortcuts";
import { isEditableFocused } from "~/lib/editableFocus";
import { isPreviewFocused } from "~/lib/previewFocus";

import { BrowserDocumentFrame } from "./BrowserDocumentFrame";

const MAC = /mac|iphone|ipad/i.test(navigator.platform);

/** The chat's real window shortcuts with ChatView's context and thread find. */
function ChatStandIn() {
  useChatShortcuts({
    enabled: true,
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    scriptKeybindings: [],
    getShortcutContext: (target) => ({
      terminalFocus: false,
      terminalOpen: false,
      previewFocus: isPreviewFocused(),
      previewOpen: false,
      isWeb: true,
      isDesktop: false,
      editableFocus: isEditableFocused(target),
      modelPickerOpen: false,
    }),
    threadFindActive: false,
    composerRef: { current: null },
    branchToolbarRef: { current: null },
    closeThreadFind: () => {},
    commands: { "chat.find": () => void state.threadFind() },
    fallback: () => undefined,
  });
  return null;
}

describe("HTML render shortcuts", () => {
  it("passes Cmd/Ctrl+F from a chat HTML render to thread find", async () => {
    state.threadFind.mockClear();
    await using screen = await render(
      <>
        <ChatStandIn />
        <div style={{ display: "flex", height: 200 }}>
          <BrowserDocumentFrame src="about:blank" title="Report" pdf={false} htmlRender />
        </div>
      </>,
      { router: false /* nothing links */ },
    );
    const frame = screen.container.querySelector("iframe")!;
    // A real click focuses the frame and gives the user activation the bridge requires.
    await userEvent.click(frame);
    expect(document.activeElement).toBe(frame);
    // The page's bridge script reports the key press it saw.
    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame.contentWindow,
        data: {
          jsonrpc: "2.0",
          method: "goat/notifications/keydown",
          params: { key: "f", code: "KeyF", metaKey: MAC, ctrlKey: !MAC },
        },
      }),
    );
    expect(state.threadFind).toHaveBeenCalledTimes(1);
  });
});
