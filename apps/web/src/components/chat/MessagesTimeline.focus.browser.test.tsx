import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";
import { createWorkspaceFocusController, workspaceAreaProps } from "../../lib/workspaceFocus";
import { MessagesTimeline } from "./MessagesTimeline";
import { baseProps, message, renderElement } from "./MessagesTimeline.browserHarness";

it("scrolls from the keyboard once F6 moves into the conversation", async () => {
  const props = baseProps();
  const entries = Array.from({ length: 40 }, (_, index) =>
    message(`Turn ${index}:\n\n${"x ".repeat(200)}`, {}, `turn-${index}`),
  );
  await using _screen = await renderElement(
    <>
      <div
        {...workspaceAreaProps("conversation", 1, "Conversation")}
        className="relative flex min-h-0 flex-1 flex-col"
      >
        <MessagesTimeline {...props} timelineEntries={entries} />
      </div>
      <div {...workspaceAreaProps("composer", 2, "Message input")}>
        <button type="button">Send</button>
      </div>
    </>,
  );
  const focus = createWorkspaceFocusController(document);
  using _focus = { [Symbol.dispose]: focus.dispose };
  const viewport = props.listRef.current!.getScrollableNode()!;
  await vi.waitFor(() => expect(viewport.scrollTop).toBeGreaterThan(0));
  const atEnd = viewport.scrollTop;
  page.getByRole("button", { name: "Send" }).element().focus();
  await userEvent.keyboard("{F6}");
  focus.move(-1);
  expect(viewport).toHaveAttribute("data-workspace-keyboard-focus");
  await userEvent.keyboard("{PageUp}");
  await vi.waitFor(() => expect(viewport.scrollTop).toBeLessThan(atEnd));
});
