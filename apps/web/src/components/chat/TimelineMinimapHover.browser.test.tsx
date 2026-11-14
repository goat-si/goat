import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import "~/index.css";
import { TimelineMinimap } from "./TimelineMinimap";

it("keeps the message underneath a minimap preview clickable", async () => {
  const clicked = vi.fn();
  await using screen = await render(
    <div style={{ position: "relative", height: 400, width: 500 }}>
      <button style={{ position: "absolute", inset: 0, width: 500, height: 400 }} onClick={clicked}>
        Underlying message
      </button>
      <TimelineMinimap
        hasPersistentGutter
        hitStripWidth={40}
        currentIndex={0}
        atEnd={false}
        items={[
          { id: "one", rowIndex: 0, userText: "First", assistantText: null },
          { id: "two", rowIndex: 1, userText: "Second", assistantText: null },
        ]}
        stripMap={new Map()}
        onWheel={() => {}}
        onSelect={() => {}}
      />
    </div>,
  );
  await userEvent.hover(screen.getByRole("button", { name: "Jump to message: User message" }));
  const button = screen.getByRole("button", { name: "Underlying message" }).element();
  const preview = screen.container.querySelector("[data-minimap-preview]");
  expect(preview).not.toBeNull();
  const bounds = preview!.getBoundingClientRect();
  const target = document.elementFromPoint(
    bounds.left + bounds.width / 2,
    bounds.top + bounds.height / 2,
  );
  expect(target).toBe(button);
  (target as HTMLElement).click();
  expect(clicked).toHaveBeenCalledOnce();
});
