import type { CSSProperties } from "react";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import "~/index.css";
import { Sidebar, SidebarProvider, SidebarRail, SidebarTrigger, useSidebar } from "./sidebar";

function CollapseFromInside() {
  const { setOpen } = useSidebar();
  return (
    <button type="button" onClick={() => setOpen(false)}>
      Collapse
    </button>
  );
}

function Harness(props: { readonly onResize?: (width: number) => void }) {
  return (
    <SidebarProvider defaultOpen>
      <Sidebar
        collapsible="offcanvas"
        resizable={{
          minWidth: 200,
          maxWidth: 600,
          ...(props.onResize ? { onResize: props.onResize } : {}),
        }}
      >
        <CollapseFromInside />
        <SidebarRail />
      </Sidebar>
      <SidebarTrigger />
    </SidebarProvider>
  );
}

// The fixed sidebar would cover a trigger rendered in flow.
function OutsideTrigger() {
  return (
    <div style={{ position: "fixed", right: 0, top: 0 }}>
      <SidebarTrigger />
    </div>
  );
}

describe("Sidebar", () => {
  it("hands focus to the outside trigger when it collapses around the focused control", async () => {
    await page.viewport(1280, 800);
    await using screen = await render(<Harness />, { router: false /* no routes involved */ });

    await userEvent.click(screen.getByRole("button", { name: "Collapse" }));

    const sidebar = screen.container.querySelector<HTMLElement>('[data-slot="sidebar"]')!;
    await vi.waitFor(() => expect(sidebar.inert).toBe(true));
    const trigger = screen.container.querySelector('[data-slot="sidebar-trigger"]');
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("abandons a rail drag when the sidebar collapses mid-drag", async () => {
    await page.viewport(1280, 800);
    const onResize = vi.fn();
    await using screen = await render(<Harness onResize={onResize} />, {
      router: false /* no routes involved */,
    });
    const rail = screen.container.querySelector<HTMLElement>('[data-sidebar="rail"]')!;
    const { left, top } = rail.getBoundingClientRect();
    const pointer = { bubbles: true, cancelable: true, pointerId: 1, button: 0, clientY: top + 10 };
    const dragTo = (clientX: number) => {
      rail.dispatchEvent(new PointerEvent("pointerdown", { ...pointer, clientX: left }));
      rail.dispatchEvent(new PointerEvent("pointermove", { ...pointer, clientX }));
    };
    // A completed drag commits, so the abandoned one below is a real drag too.
    dragTo(left + 40);
    rail.dispatchEvent(new PointerEvent("pointerup", { ...pointer, clientX: left + 40 }));
    expect(onResize).toHaveBeenCalledTimes(1);

    dragTo(left + 80);
    await userEvent.click(
      screen.container.querySelector<HTMLElement>('[data-slot="sidebar-trigger"]')!,
    );
    rail.dispatchEvent(new PointerEvent("pointerup", { ...pointer, clientX: left + 80 }));

    expect(onResize).toHaveBeenCalledTimes(1);
  });

  it("hides a collapsed framed sidebar's rows instead of parking them under the rail", async () => {
    await page.viewport(1280, 800);
    await using screen = await render(
      <SidebarProvider defaultOpen style={{ "--destination-rail-width": "56px" } as CSSProperties}>
        <Sidebar collapsible="offcanvas" variant="framed">
          <span>57m</span>
          <SidebarRail />
        </Sidebar>
        <OutsideTrigger />
      </SidebarProvider>,
      { router: false /* no routes involved */ },
    );
    const trigger = screen.container.querySelector<HTMLElement>('[data-slot="sidebar-trigger"]')!;
    const rail = screen.container.querySelector<HTMLElement>('[data-slot="sidebar-rail"]')!;
    await expect.element(screen.getByText("57m")).toBeVisible();

    await userEvent.click(trigger);
    await expect.element(screen.getByText("57m")).not.toBeVisible();
    await expect.element(rail).not.toBeVisible();
    await expect.element(trigger).toBeVisible();

    await userEvent.click(trigger);
    await expect.element(screen.getByText("57m")).toBeVisible();
  });

  it("never paints a sliding framed sidebar under the rail", async () => {
    await page.viewport(1280, 800);
    const railWidth = 56;
    // browserNoMotion zeroes every transition; this test needs the slide itself.
    const noMotion = document.querySelector<HTMLStyleElement>("style[data-test-no-motion]")!;
    noMotion.disabled = true;
    using _motion = { [Symbol.dispose]: () => void (noMotion.disabled = false) };
    await using screen = await render(
      <div
        data-panel-animations="true"
        style={{ "--panel-animation-duration": "1000ms" } as CSSProperties}
      >
        <SidebarProvider
          defaultOpen
          style={{ "--destination-rail-width": `${railWidth}px` } as CSSProperties}
        >
          <Sidebar collapsible="offcanvas" variant="framed">
            <span>57m</span>
          </Sidebar>
          <OutsideTrigger />
        </SidebarProvider>
      </div>,
      { router: false /* no routes involved */ },
    );
    const container = screen.container.querySelector<HTMLElement>(
      '[data-slot="sidebar-container"]',
    )!;
    await userEvent.click(
      screen.container.querySelector<HTMLElement>('[data-slot="sidebar-trigger"]')!,
    );
    await vi.waitFor(() => expect(container.getAnimations().length).toBeGreaterThan(0));
    for (const animation of container.getAnimations()) {
      animation.pause();
      animation.currentTime = 500;
    }

    const { left } = container.getBoundingClientRect();
    const clipLeft = /inset\(.*\s(-?[\d.]+)px\)$/.exec(getComputedStyle(container).clipPath);
    expect(left).toBeLessThan(railWidth);
    expect(left + Number(clipLeft?.[1] ?? 0)).toBeGreaterThanOrEqual(railWidth - 0.5);
  });
});

it("restores collapsed and expanded desktop state after remounting", async () => {
  await page.viewport(1280, 800);
  const storageKey = "sidebar_persistence_test";
  localStorage.removeItem(storageKey);
  const layout = () => (
    <SidebarProvider storageKey={storageKey}>
      <SidebarTrigger />
    </SidebarProvider>
  );
  {
    await using screen = await render(layout(), { router: false /* no routes involved */ });
    const trigger = screen.getByRole("button", { name: "Toggle Sidebar" });
    await expect.element(trigger).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(trigger);
    await expect.element(trigger).toHaveAttribute("aria-pressed", "false");
  }
  {
    await using screen = await render(layout(), { router: false /* no routes involved */ });
    const trigger = screen.getByRole("button", { name: "Toggle Sidebar" });
    await expect.element(trigger).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(trigger);
  }
  await using screen = await render(layout(), { router: false /* no routes involved */ });
  await expect
    .element(screen.getByRole("button", { name: "Toggle Sidebar" }))
    .toHaveAttribute("aria-pressed", "true");
  localStorage.removeItem(storageKey);
});

it("keeps the mobile sheet closed and leaves the saved desktop state alone", async () => {
  await page.viewport(390, 844);
  const storageKey = "sidebar_mobile_persistence_test";
  localStorage.setItem(storageKey, "false");
  {
    await using screen = await render(
      <SidebarProvider storageKey={storageKey}>
        <SidebarTrigger />
      </SidebarProvider>,
      { router: false /* no routes involved */ },
    );
    const trigger = screen.getByRole("button", { name: "Toggle Sidebar" });
    await expect.element(trigger).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(trigger);
    await expect.element(trigger).toHaveAttribute("aria-pressed", "true");
    expect(localStorage.getItem(storageKey)).toBe("false");
  }
  await using screen = await render(
    <SidebarProvider storageKey={storageKey}>
      <SidebarTrigger />
    </SidebarProvider>,
    { router: false /* no routes involved */ },
  );
  await expect
    .element(screen.getByRole("button", { name: "Toggle Sidebar" }))
    .toHaveAttribute("aria-pressed", "false");
  localStorage.removeItem(storageKey);
});

function MobileSheetMountedProbe() {
  const { mobileSheetMounted } = useSidebar();
  return <output aria-label="Sheet mounted">{String(mobileSheetMounted)}</output>;
}

it("keeps closed mobile sheet contents mounted and reports the sheet only while it shows", async () => {
  await page.viewport(390, 844);
  await using screen = await render(
    <SidebarProvider>
      <Sidebar>
        <span>Sheet contents</span>
      </Sidebar>
      <SidebarTrigger />
      <MobileSheetMountedProbe />
    </SidebarProvider>,
    { router: false /* no routes involved */ },
  );
  const sheetMounted = screen.getByLabelText("Sheet mounted");
  // Window shortcuts registered by sidebar children only work while they stay mounted.
  expect(document.querySelector('[data-mobile="true"]')?.textContent).toContain("Sheet contents");
  await expect.element(sheetMounted).toHaveTextContent("false");

  await userEvent.click(screen.getByRole("button", { name: "Toggle Sidebar" }));
  await expect.element(sheetMounted).toHaveTextContent("true");

  await userEvent.keyboard("{Escape}");
  await expect.element(sheetMounted).toHaveTextContent("false");
  expect(document.querySelector('[data-mobile="true"]')?.textContent).toContain("Sheet contents");
});
