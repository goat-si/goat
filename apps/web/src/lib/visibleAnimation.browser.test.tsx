import { describe, expect, it, vi } from "vite-plus/test";

import { ComposerSurface } from "../components/chat/ComposerSurface";
import "../index.css";
import { render } from "../../test/render";
import { observeVisibleAnimation } from "./visibleAnimation";

/** The suite zeroes animation durations; remove the test stylesheet to inspect real CSS motion. */
function withMotion(): Disposable {
  const noMotion = document.head.querySelector("style[data-test-no-motion]");
  noMotion?.remove();
  return { [Symbol.dispose]: () => void (noMotion && document.head.append(noMotion)) };
}

describe("sidebar animation and glass backdrop containment", () => {
  it("runs sidebar spinner only while intersecting and document is visible, with layout+paint containment", async () => {
    using _motion = withMotion();
    let visibility: DocumentVisibilityState = "visible";
    using _visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockImplementation(() => visibility);

    // Router off: static spinner fixture with no links.
    await using screen = await render(
      <svg
        ref={observeVisibleAnimation}
        data-testid="sidebar-spinner"
        viewBox="0 0 16 16"
        className="size-3.5 shrink-0 motion-safe:visible-animate-sidebar-spin motion-reduce:animate-none"
        fill="none"
      />,
      { router: false },
    );

    const spinner = screen.container.querySelector('[data-testid="sidebar-spinner"]');
    if (!(spinner instanceof SVGSVGElement)) throw new Error("expected sidebar spinner svg");

    await vi.waitFor(() => {
      expect(getComputedStyle(spinner).animationPlayState).toBe("running");
    });
    expect(getComputedStyle(spinner).contain).toBe("layout paint");
    expect(getComputedStyle(spinner).animationTimingFunction).toContain("steps(16");

    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(getComputedStyle(spinner).animationPlayState).toBe("paused");
    expect(spinner.style.getPropertyValue("--visible-animation-will-change")).toBe("auto");

    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(getComputedStyle(spinner).animationPlayState).toBe("running");
  });

  it("disables composer backdrop-filter when data-glass-solid is set", async () => {
    const root = document.documentElement;
    const hadSolid = root.hasAttribute("data-glass-solid");
    try {
      // Router off: static composer surface shell with no links.
      await using screen = await render(
        <ComposerSurface.Shell>
          <div />
        </ComposerSurface.Shell>,
        { router: false },
      );
      const shell = screen.container.querySelector('[data-slot="composer-shell"]');
      if (!(shell instanceof HTMLElement)) throw new Error("expected composer shell");

      root.removeAttribute("data-glass-solid");
      expect(getComputedStyle(shell, "::before").backdropFilter).toContain("blur(");

      root.setAttribute("data-glass-solid", "");
      expect(getComputedStyle(shell, "::before").backdropFilter).toBe("none");
    } finally {
      if (!hadSolid) root.removeAttribute("data-glass-solid");
      else root.setAttribute("data-glass-solid", "");
    }
  });
});
