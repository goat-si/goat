import { describe, expect, it, vi } from "vite-plus/test";
import "~/index.css";

import { render } from "../../../test/render";
import { MermaidFilePreview } from "./MermaidFilePreview";

describe("standalone Mermaid previews", () => {
  it.each([
    'A@{ "img": "//attacker.invalid/pixel.png" }',
    'A@{ "im\\u0067": "/pixel.png" }',
    "A@{ label: &key img, *key: '/pixel.png' }",
    'A["<img src=//attacker.invalid/pixel.png>"]',
  ])("rejects resource syntax before Mermaid lays out %s", async (node) => {
    using imageSource = vi
      .spyOn(HTMLImageElement.prototype, "src", "set")
      .mockImplementation(() => {});
    await using screen = await render(<MermaidFilePreview text={`flowchart LR\n${node}`} />);
    await vi.waitFor(() =>
      expect(screen.container.querySelector('[role="alert"]')?.textContent).toContain(
        "Show Mermaid source",
      ),
    );
    expect(imageSource).not.toHaveBeenCalled();
    expect(screen.container.querySelector("svg")).toBeNull();
  });

  it.each(["<-->", "<==>", "<-.->", "-->"])("renders the %s arrow", async (arrow) => {
    await using screen = await render(<MermaidFilePreview text={`flowchart LR\nA ${arrow} B`} />);
    await vi.waitFor(
      () => {
        const diagram = screen.container.querySelector("svg");
        expect(diagram?.querySelector("path")).not.toBeNull();
        expect(diagram?.textContent).toContain("A");
        expect(diagram?.textContent).toContain("B");
      },
      { timeout: 10_000 },
    );
    expect(screen.container.querySelector('[role="alert"]')).toBeNull();
  });
});
