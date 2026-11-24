import { GTProvider } from "gt-react";
import zh from "../../i18n/translations/zh.json";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import type { ReactNode } from "react";

import { act, render } from "../../../test/render";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { SettingsPageShell } from "./SettingsPageShell";
import { ThemeEditorPanel } from "./ThemeEditorPanel";

function dragHeader(panel: HTMLElement, toX: number, toY: number) {
  const header = panel.querySelector<HTMLElement>("h2")!.closest<HTMLElement>(".cursor-grab")!;
  const rect = panel.getBoundingClientRect();
  const start = { clientX: rect.left + 40, clientY: rect.top + 10 };
  const init = { bubbles: true, button: 0, pointerId: 1 };
  header.dispatchEvent(new PointerEvent("pointerdown", { ...init, ...start }));
  header.dispatchEvent(
    new PointerEvent("pointermove", { ...init, clientX: toX + 40, clientY: toY + 10 }),
  );
  header.dispatchEvent(new PointerEvent("pointerup", init));
}

function dragResizeHandle(panel: HTMLElement, byX: number) {
  const handle = panel.querySelector<HTMLElement>(".cursor-se-resize")!;
  const rect = handle.getBoundingClientRect();
  const init = { bubbles: true, button: 0, pointerId: 2 };
  const start = { clientX: rect.left + 4, clientY: rect.top + 4 };
  handle.dispatchEvent(new PointerEvent("pointerdown", { ...init, ...start }));
  handle.dispatchEvent(
    new PointerEvent("pointermove", {
      ...init,
      clientX: start.clientX + byX,
      clientY: start.clientY,
    }),
  );
  handle.dispatchEvent(new PointerEvent("pointerup", init));
}

function pointerAt(target: HTMLElement, type: string, xFraction: number) {
  const rect = target.getBoundingClientRect();
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      button: 0,
      pointerId: 3,
      clientX: rect.left + rect.width * xFraction,
      clientY: rect.top + rect.height / 2,
    }),
  );
}

async function renderPanel(appContent?: ReactNode) {
  await page.viewport(1280, 900);
  await using stack = new AsyncDisposableStack();
  // Synthetic pointer ids are not active pointers, so the browser would reject capture.
  stack.use(vi.spyOn(HTMLElement.prototype, "setPointerCapture").mockImplementation(() => {}));
  // Tailwind is not loaded here; give the panel its fixed, card-sized box.
  const style = document.head.appendChild(document.createElement("style"));
  style.textContent = "[data-theme-editor-panel]{position:fixed;width:400px;height:300px}";
  stack.defer(() => style.remove());
  const screen = stack.use(
    await render(
      <>
        {appContent}
        <ThemeEditorPanel
          open
          onOpenChange={() => {}}
          onSaved={() => true}
          editingTheme={null}
          initialAppearance="dark"
          restoreTheme={() => {}}
        />
      </>,
    ),
  );
  const panel = screen.getByRole("dialog", { name: "Create theme" });
  await expect.element(panel).toBeVisible();
  const owned = stack.move();
  return {
    panel: panel.element() as HTMLElement,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

async function renderBesideSettings() {
  const onEditorOpenChange = vi.fn();
  const stack = new AsyncDisposableStack();
  const root = createRootRoute({ component: Outlet });
  const settings = createRoute({
    getParentRoute: () => root,
    path: "/settings/appearance",
    component: () => (
      <SettingsPageShell pathname="/settings/appearance">
        <button type="button">Settings page</button>
        <ThemeEditorPanel
          open
          onOpenChange={onEditorOpenChange}
          onSaved={() => true}
          editingTheme={null}
          initialAppearance="light"
          restoreTheme={() => {}}
        />
      </SettingsPageShell>
    ),
  });
  const home = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => <h1>Home view</h1>,
  });
  const router = createRouter({
    routeTree: root.addChildren([settings, home]),
    history: createMemoryHistory({ initialEntries: ["/settings/appearance"] }),
    disableGlobalCatchBoundary: true,
  });
  await router.load();
  stack.use(await render(<RouterProvider router={router} />, { router: false }));
  return {
    router,
    onEditorOpenChange,
    [Symbol.asyncDispose]: () => stack.disposeAsync(),
  };
}

async function pressImeEscapes(target: HTMLElement) {
  // The bare 229 goes first, before a compositionend opens Base UI's own composition window.
  for (const { compositionEnd, ...composition } of [
    { key: "Escape", isComposing: false, keyCode: 229, compositionEnd: false },
    { key: "Escape", isComposing: true, keyCode: 27, compositionEnd: false },
    // Safari ends the composition just before the Escape keydown.
    { key: "Escape", isComposing: false, keyCode: 229, compositionEnd: true },
  ]) {
    const keydown = new KeyboardEvent("keydown", {
      ...composition,
      bubbles: true,
      cancelable: true,
    });
    await act(() => {
      if (compositionEnd)
        target.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      target.dispatchEvent(keydown);
    });
    expect(keydown.defaultPrevented).toBe(false);
  }
}
async function editorElement(selector: string) {
  const query = () => document.querySelector<HTMLElement>(`[data-theme-editor-panel] ${selector}`);
  await expect.poll(query).toBeTruthy();
  return query()!;
}

describe("ThemeEditorPanel", () => {
  it("rejects unsafe CSS before saving the theme", async () => {
    const onSaved = vi.fn(() => true);
    await using _screen = await render(
      <ThemeEditorPanel
        open
        onOpenChange={() => {}}
        onSaved={onSaved}
        editingTheme={null}
        initialAppearance="light"
        restoreTheme={() => {}}
      />,
    );
    await userEvent.fill(page.getByLabelText("Theme name"), "CSS test");
    await userEvent.fill(
      page.getByLabelText("Custom CSS"),
      '@import "https://evil.example/x.css";',
    );
    await page.getByRole("button", { name: "Create theme" }).click();
    await expect.element(page.getByRole("alert")).toBeVisible();
    expect(onSaved).not.toHaveBeenCalled();
  });
  it("keeps its left edge when resized after the window shrank", async () => {
    await using view = await renderPanel();
    dragHeader(view.panel, 700, 40);
    await expect.poll(() => view.panel.style.left).toBe("700px");

    await page.viewport(600, 900);
    await expect.poll(() => Number.parseFloat(view.panel.style.left)).toBeLessThan(600);
    const clampedLeft = view.panel.style.left;

    dragResizeHandle(view.panel, -100);
    await expect.poll(() => view.panel.style.width).not.toBe("");
    expect(view.panel.style.left).toBe(clampedLeft);
  });

  it("returns to where the user left it when the window shrinks and grows back", async () => {
    await page.viewport(1280, 900);
    // Synthetic pointer ids are not active pointers, so the browser would reject capture.
    using _capture = vi
      .spyOn(HTMLElement.prototype, "setPointerCapture")
      .mockImplementation(() => {});
    // Tailwind is not loaded here; give the panel its fixed, card-sized box.
    const style = document.head.appendChild(document.createElement("style"));
    style.textContent = "[data-theme-editor-panel]{position:fixed;width:400px;height:300px}";
    using _style = { [Symbol.dispose]: () => style.remove() };
    await using screen = await render(
      <ThemeEditorPanel
        open
        onOpenChange={() => {}}
        onSaved={() => true}
        editingTheme={null}
        initialAppearance="dark"
        restoreTheme={() => {}}
      />,
    );
    const panel = screen.getByRole("dialog", { name: "Create theme" });
    await expect.element(panel).toBeVisible();

    dragHeader(panel.element() as HTMLElement, 700, 40);
    await expect.poll(() => (panel.element() as HTMLElement).style.left).toBe("700px");

    await page.viewport(600, 900);
    await expect
      .poll(() => Number.parseFloat((panel.element() as HTMLElement).style.left))
      .toBeLessThan(600);

    await page.viewport(1280, 900);
    await expect.poll(() => (panel.element() as HTMLElement).style.left).toBe("700px");
  });

  it("restores the colors from before the picker opened when Escape closes it", async () => {
    await using _view = await renderPanel();
    const hex = page.getByRole("textbox", { name: "Accent hex value" });
    const original = (hex.element() as HTMLInputElement).value;
    await userEvent.click(page.getByRole("button", { name: "Choose Accent color" }));
    const hue = page.getByRole("slider", { name: "Accent hue" });
    await expect.element(hue).toBeInTheDocument();
    const hueSlider = hue.element() as HTMLElement;

    await act(async () => {
      pointerAt(hueSlider, "pointerdown", 0.5);
      pointerAt(hueSlider, "pointerup", 0.5);
    });
    await expect.element(hex).not.toHaveValue(original);
    const edited = (hex.element() as HTMLInputElement).value;

    const pickerHex = page.getByRole("textbox", { name: "Accent picker hex value" });
    await act(() =>
      pickerHex.element().dispatchEvent(new KeyboardEvent("keydown", IME_ESCAPE_229)),
    );
    await expect.element(hue).toBeInTheDocument();
    expect((hex.element() as HTMLInputElement).value).toBe(edited);

    await act(async () => {
      pointerAt(hueSlider, "pointerdown", 0.25);
      hueSlider.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
      // The drag keeps going while the picker animates out.
      pointerAt(hueSlider, "pointermove", 0.75);
      pointerAt(hueSlider, "pointerup", 0.75);
    });
    expect((hex.element() as HTMLInputElement).value).toBe(original);
  });

  it("keeps the typed text while backspacing the background hex past valid shorthand", async () => {
    await using _view = await renderPanel();
    const hex = page.getByRole("textbox", { name: "Background hex value" });
    await userEvent.fill(hex, "#222222");
    await expect.element(hex).toHaveValue("#222222");

    // Four- and three-digit prefixes are valid shorthand; the guided palette must not rewrite them.
    for (const expected of ["#22222", "#2222", "#222", "#22", "#2", "#", ""]) {
      await userEvent.keyboard("{Backspace}");
      await expect.element(hex).toHaveValue(expected);
    }

    await userEvent.keyboard("#3366cc");
    await expect.element(hex).toHaveValue("#3366cc");
    await act(async () => (hex.element() as HTMLInputElement).blur());
    await expect.element(hex).toHaveValue("#3366cc");
  });

  it("commits a typed shorthand hex when inspecting an advanced color switches modes", async () => {
    await using _view = await renderPanel(<div className="bg-sidebar" data-testid="app-sidebar" />);
    await userEvent.click(page.getByRole("button", { name: "Inspect app colors" }));
    await userEvent.fill(page.getByRole("textbox", { name: "Background hex value" }), "#abc");

    // Inspect mode cancels the pointerdown, so the hex field keeps focus while it unmounts.
    const sidebar = page.getByTestId("app-sidebar").element() as HTMLElement;
    await act(async () => pointerAt(sidebar, "pointerdown", 0.5));

    await expect
      .element(page.getByRole("switch", { name: "Use advanced theme colors" }))
      .toBeChecked();
    await expect
      .element(page.getByRole("textbox", { name: "Background hex value" }))
      .toHaveValue("#aabbcc");
  });

  it("closes on Escape without closing Settings", async () => {
    await using view = await renderBesideSettings();
    const windowKeys = vi.fn();
    window.addEventListener("keydown", windowKeys);
    using _windowKeys = {
      [Symbol.dispose]: () => window.removeEventListener("keydown", windowKeys),
    };
    const input = await editorElement("input");
    input.focus();
    await pressImeEscapes(input);
    expect(view.onEditorOpenChange).not.toHaveBeenCalled();
    expect(view.router.state.location.pathname).toBe("/settings/appearance");
    windowKeys.mockClear();

    await userEvent.keyboard("{Escape}");

    expect(view.onEditorOpenChange).toHaveBeenCalledWith(false);
    expect(view.router.state.location.pathname).toBe("/settings/appearance");
    expect(windowKeys).not.toHaveBeenCalled();
    await userEvent.click(page.getByRole("button", { name: "Settings page" }));
    await userEvent.keyboard("{Escape}");
    expect(windowKeys).toHaveBeenCalled();
    await expect.element(page.getByRole("heading", { name: "Home view" })).toBeVisible();
  });

  it("leaves inspection on Escape without closing the editor or Settings", async () => {
    await using view = await renderBesideSettings();
    (await editorElement('[aria-label="Inspect app colors"]')).click();
    await editorElement('[aria-label="Cancel inspecting app colors"]');
    await pressImeEscapes(await editorElement("input"));
    await editorElement('[aria-label="Cancel inspecting app colors"]');
    expect(view.onEditorOpenChange).not.toHaveBeenCalled();
    expect(view.router.state.location.pathname).toBe("/settings/appearance");

    await userEvent.keyboard("{Escape}");

    await editorElement('[aria-label="Inspect app colors"]');
    expect(view.onEditorOpenChange).not.toHaveBeenCalled();
    expect(view.router.state.location.pathname).toBe("/settings/appearance");
  });
});

it("filters advanced color families by their translated names", async () => {
  await using screen = await render(
    <GTProvider locale="zh" translations={{ zh }}>
      <ThemeEditorPanel
        open
        onOpenChange={() => {}}
        onSaved={() => true}
        editingTheme={null}
        initialAppearance="light"
        restoreTheme={() => {}}
      />
    </GTProvider>,
  );
  const advanced = screen.getByRole("switch", { name: "启用高级主题配色" });
  (advanced.element() as HTMLElement).focus();
  await userEvent.keyboard(" ");
  await expect.element(advanced).toBeChecked();
  await screen.getByPlaceholder("筛选颜色").fill("终端背景");
  await expect.element(screen.getByText("终端背景", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("侧边栏背景", { exact: true })).not.toBeInTheDocument();
});
