import { useAtomValue } from "@effect/atom-react";
import { htmlRenderTheme } from "@goat/shared/htmlRender";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@goat/shared/keybindings";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

const state = vi.hoisted(() => ({ threadFind: vi.fn() }));

vi.mock(import("@effect/atom-react"), { spy: true });
vi.mock(import("~/hooks/useHtmlRenderTheme"), { spy: true });
vi.mock("~/browser/useOpenLink", () => ({ useOpenLink: () => vi.fn() }));
vi.mock("~/lib/openPullRequestLink", () => ({ useOpenChangeRequestLink: () => vi.fn() }));

import { useChatShortcuts } from "~/components/chat/useChatShortcuts";
import { useHtmlRenderTheme } from "~/hooks/useHtmlRenderTheme";
import { isEditableFocused } from "~/lib/editableFocus";
import { isPreviewFocused } from "~/lib/previewFocus";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { getStandardThemeColors } from "~/themePalette";

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
    // A stable theme keeps the frame from re-posting it on every render.
    vi.mocked(useHtmlRenderTheme).mockReturnValue(
      htmlRenderTheme(getStandardThemeColors("dark"), "dark"),
    );
    vi.mocked(useAtomValue).mockImplementation(((atom: unknown) =>
      atom === primaryServerKeybindingsAtom ? DEFAULT_RESOLVED_KEYBINDINGS : undefined) as never);
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
