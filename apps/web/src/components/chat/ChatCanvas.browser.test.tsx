import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { ChatCanvas } from "./ChatCanvas";
import { useChatCanvas } from "./ChatCanvasContext";
import { resolveThreadDetailsCardLayout } from "./threadDetailsCardLayout";
import "../../index.css";

function CardPlacement() {
  const canvas = useChatCanvas();
  if (!canvas) return null;
  const placement = resolveThreadDetailsCardLayout({
    container: canvas.container,
    narrowestWidth: canvas.narrowestWidth,
    lane: canvas.lane,
    frame: null,
  });
  return <span>{placement ? "inline card" : "popover card"}</span>;
}

it("keeps the card out of the canvas while a panel narrows it", async () => {
  await using screen = await render(
    <div data-panel-animations="true" style={{ display: "flex", width: 1344, height: 900 }}>
      <div
        data-slot="sidebar-gap"
        style={{ width: 0, flexShrink: 0, transition: "width 60s linear" }}
      />
      <ChatCanvas composerOverlayElement={null}>
        <CardPlacement />
      </ChatCanvas>
    </div>,
  );
  await expect.element(screen.getByText("inline card")).toBeVisible();
  const panel = screen.container.querySelector<HTMLElement>('[data-slot="sidebar-gap"]')!;
  panel.style.setProperty("transition-duration", "60s", "important");
  expect(getComputedStyle(panel).transitionDuration).toBe("60s");
  panel.getBoundingClientRect();
  panel.style.width = "540px";
  await vi.waitFor(() => expect(panel.getAnimations().length).toBeGreaterThan(0));
  const animation = panel.getAnimations()[0]!;
  animation.currentTime = 100;
  await expect.element(screen.getByText("popover card")).toBeVisible();
});
