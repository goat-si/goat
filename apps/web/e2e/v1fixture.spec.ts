// v1 CSS scoping and portal root (devlog 070 Revision A2.2-3): v1 tokens apply inside [data-v1], identical plain
// elements outside keep browser defaults, and portalled popups land in the [data-v1][data-v1-portal] root.
import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1000, height: 700 } });

const css = (page: import("@playwright/test").Page, testId: string, props: string[]) =>
  page.getByTestId(testId).evaluate((el, ps) => {
    const s = getComputedStyle(el);
    return Object.fromEntries(ps.map((p) => [p, s.getPropertyValue(p)]));
  }, props);

test("v1 styles stay inside [data-v1]; portals go to [data-v1-portal]", async ({ page }) => {
  await page.goto("/?v1fixture");
  await expect(page.getByTestId("v1-popover")).toBeVisible();
  await expect(page.getByTestId("v1-tooltip")).toBeVisible();

  // v1 --text-work-log: 0.78125rem (index.css) = 12.5px; outside, the same class has no token -> browser default 16px.
  expect((await css(page, "v1-text", ["font-size"]))["font-size"]).toBe("12.5px");
  expect((await css(page, "plain-text", ["font-size"]))["font-size"]).toBe("16px");

  // Preflight inside: v1 button has no UA border and v1 radius; outside: UA button and h1 untouched.
  const inside = await css(page, "v1-button", ["border-top-style", "cursor", "font-family"]);
  const outside = await css(page, "plain-button", ["border-top-style", "font-family"]);
  expect(outside["border-top-style"]).toBe("outset");
  expect(inside["border-top-style"]).not.toBe("outset");
  expect(inside["font-family"]).not.toBe(outside["font-family"]);
  expect((await css(page, "plain-h1", ["font-size", "font-weight"]))).toEqual({ "font-size": "32px", "font-weight": "700" });

  // Tokens: --background is defined on the boundary, not on <html>.
  const tokens = await page.evaluate(() => ({
    html: getComputedStyle(document.documentElement).getPropertyValue("--background").trim(),
    boundary: getComputedStyle(document.querySelector("[data-testid=inside]")!).getPropertyValue("--background").trim(),
  }));
  expect(tokens.html).toBe("");
  expect(tokens.boundary).not.toBe("");

  // Both portals are inside the single v1 portal root under <body>, and are styled by v1.
  const portals = await page.evaluate(() => {
    const roots = document.querySelectorAll("body > [data-v1][data-v1-portal]");
    const inRoot = (id: string) => !!roots[0]?.contains(document.querySelector(`[data-testid=${id}]`));
    return { roots: roots.length, popover: inRoot("v1-popover"), tooltip: inRoot("v1-tooltip") };
  });
  expect(portals).toEqual({ roots: 1, popover: true, tooltip: true });
  const pop = await css(page, "v1-popover", ["border-top-left-radius", "background-color"]);
  expect(pop["border-top-left-radius"]).not.toBe("0px");
  // Painted and unclipped: the element at each popup's centre belongs to that popup. v1 tooltips are
  // pointer-events-none by design (ui/tooltip.tsx), so the check lifts that for the tooltip only.
  for (const id of ["v1-popover", "v1-tooltip"]) {
    const hit = await page.getByTestId(id).evaluate((el) => {
      const lifted: HTMLElement[] = [];
      for (let e: HTMLElement | null = el as HTMLElement; e && !e.hasAttribute("data-v1-portal"); e = e.parentElement) {
        if (getComputedStyle(e).pointerEvents === "none") { e.style.pointerEvents = "auto"; lifted.push(e); }
      }
      const r = el.getBoundingClientRect();
      const ok = el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
      for (const e of lifted) e.style.pointerEvents = "";
      return ok;
    });
    expect(hit, id).toBe(true);
  }
  // Shrink-to-fit popups get the viewport's width, as under v1's <body>: the tooltip text stays on one line.
  expect((await page.getByTestId("v1-tooltip").boundingBox())!.height).toBeLessThan(40);
  // The root itself lets clicks through to GOAT 2 underneath.
  expect(await page.evaluate(() => getComputedStyle(document.querySelector("[data-v1-portal]")!).pointerEvents)).toBe("none");

  // The boundary is an ordinary block: v1's page rules (overflow hidden, 100svh) apply only under [data-v1-body].
  expect(await css(page, "inside", ["overflow-y", "position"])).toEqual({ "overflow-y": "visible", position: "static" });
});
