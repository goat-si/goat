import { expect, it, vi } from "vite-plus/test";
import { render } from "../../test/render";
import "../index.css";

function fixtureAttributes(attributes: Record<string, string>): Disposable {
  const root = document.documentElement;
  const previous = new Map(Object.keys(attributes).map((name) => [name, root.getAttribute(name)]));
  for (const [name, value] of Object.entries(attributes)) root.setAttribute(name, value);
  return {
    [Symbol.dispose]() {
      for (const [name, value] of previous) {
        if (value === null) root.removeAttribute(name);
        else root.setAttribute(name, value);
      }
    },
  };
}

function alpha(element: Element): number {
  const context = document.createElement("canvas").getContext("2d");
  if (!context) throw new Error("Canvas unavailable");
  context.fillStyle = getComputedStyle(element).backgroundColor;
  context.fillRect(0, 0, 1, 1);
  return context.getImageData(0, 0, 1, 1).data[3] ?? 0;
}

function element(container: HTMLElement, selector: string): Element {
  const found = container.querySelector(selector);
  if (!found) throw new Error(`Missing ${selector}`);
  return found;
}

function Shell() {
  return (
    <>
      <div data-destination-rail data-glass-pane="rail" className="bg-sidebar" />
      <div data-glass-pane="pane" data-native-material-band className="bg-background">
        <div data-glass-layer className="bg-background" />
        <input type="checkbox" defaultChecked className="checked:bg-primary" />
      </div>
      <div className="dialog-glass" />
      <div className="dialog-backdrop" />
      <div className="dropdown-glass" />
    </>
  );
}

it("tints the pane, clears its full-size layer, and preserves a checked control", async () => {
  using _attributes = fixtureAttributes({ "data-appearance-preset": "liquid-glass" });
  await using screen = await render(<Shell />);
  await vi.waitFor(() => {
    expect(alpha(element(screen.container, '[data-glass-pane="pane"]'))).toBeLessThan(255);
    expect(alpha(element(screen.container, "[data-glass-layer]"))).toBe(0);
    expect(alpha(element(screen.container, "input:checked"))).toBe(255);
    expect(alpha(element(screen.container, '[data-glass-pane="rail"]'))).toBeLessThan(255);
  });
});

it("keeps Liquid Glass selected while glass opacity 100 makes panes opaque", async () => {
  using _attributes = fixtureAttributes({
    "data-appearance-preset": "liquid-glass",
    "data-glass-solid": "",
  });
  await using screen = await render(<Shell />);
  await vi.waitFor(() => {
    expect(alpha(element(screen.container, '[data-glass-pane="pane"]'))).toBe(255);
    expect(alpha(element(screen.container, "[data-glass-layer]"))).toBe(255);
    expect(document.documentElement.dataset.appearancePreset).toBe("liquid-glass");
  });
});

it("leaves panes opaque with the Default style", async () => {
  using _attributes = fixtureAttributes({ "data-appearance-preset": "default" });
  await using screen = await render(<Shell />);
  await vi.waitFor(() => {
    expect(alpha(element(screen.container, '[data-glass-pane="pane"]'))).toBe(255);
    expect(alpha(element(screen.container, "[data-glass-layer]"))).toBe(255);
  });
});

it("lets native material show through the root and rail while restoring floating glass", async () => {
  using _attributes = fixtureAttributes({
    "data-appearance-preset": "liquid-glass",
    "data-desktop-client": "",
    "data-desktop-window-material": "macos-glass",
  });
  await using screen = await render(<Shell />);
  await vi.waitFor(() => {
    expect(alpha(document.documentElement)).toBe(0);
    expect(alpha(element(screen.container, '[data-glass-pane="rail"]'))).toBe(0);
    expect(
      getComputedStyle(element(screen.container, '[data-glass-pane="pane"]')).backgroundImage,
    ).toContain("linear-gradient");
    for (const selector of [".dialog-glass", ".dialog-backdrop", ".dropdown-glass"]) {
      const node = element(screen.container, selector);
      expect(alpha(node)).toBeLessThan(255);
      expect(getComputedStyle(node).backdropFilter).not.toBe("none");
    }
  });
});
