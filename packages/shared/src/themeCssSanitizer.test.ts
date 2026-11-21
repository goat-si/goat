import { describe, expect, it } from "vite-plus/test";
import { sanitizeThemeCss, THEME_CSS_MAX_LENGTH } from "./themeCssSanitizer.ts";
import { ThemeCssResourceError } from "./themeCssErrors.ts";

describe("theme CSS sanitizer", () => {
  it.each([
    '@import "https://evil.example/x.css";',
    '[data-slot="sidebar"]{background:url(https://evil.example/x)}',
    '[data-slot="sidebar"]{background:image-set("https://evil.example/x" 1x)}',
    '[data-slot="sidebar"]{background:-webkit-image-set("https://evil.example/x" 1x)}',
    '[data-slot="sidebar"]{background:image("https://evil.example/x")}',
    '[data-slot="sidebar"]{background:cross-fade(url(https://evil.example/x),red)}',
    '[data-slot="sidebar"]{background:element(#x)}',
    '[data-slot="sidebar"]{background:src("https://evil.example/x")}',
    '[data-slot="sidebar"]{background:"https://evil.example/x"}',
  ])("explains unsupported image resources", (css) => {
    expect(() => sanitizeThemeCss(css)).toThrow(ThemeCssResourceError);
  });
  it("scopes permitted styling to the theme root", () => {
    expect(sanitizeThemeCss('[data-slot="sidebar"] { color: #123456; }')).toContain(
      '[data-goat-theme-root] [data-slot="sidebar"]',
    );
  });

  it("scopes approved color variables to the theme root", () => {
    expect(sanitizeThemeCss(":root { --app-theme-canvas: #123456; }")).toBe(
      "[data-goat-theme-root]{--app-theme-canvas:#123456}",
    );
  });

  it("safely revalidates CSS already scoped by the server", () => {
    const css = sanitizeThemeCss('[data-slot="sidebar"]{color:red}');
    expect(sanitizeThemeCss(css)).toBe(css);
  });

  it.each([
    '@import "https://evil.example/x.css";',
    "@font-face { font-family: bad; src: url(https://evil.example/x.woff); }",
    "@namespace svg url(https://evil.example);",
    '[data-slot="sidebar"] { background: url(https://evil.example/x); }',
    '[data-slot="sidebar"] { background-image: url(data:image/png;base64,AA==); }',
    '[data-slot="sidebar"] { background: u\\72l(https://evil.example/x); }',
    '[data-slot="sidebar"] { color: expression(alert(1)); }',
    '[data-slot="sidebar"] { behavior: url(#x); }',
    '[data-slot="sidebar"] { -moz-binding: url(#x); }',
    ":root { --app-theme-canvas: var(--untrusted); }",
    '[data-slot="sidebar"] + body { color: red; }',
    ":root { color: red; }",
    "html { color: red; }",
    "body { color: red; }",
    '[data-slot="sidebar"] { animation: pulse 1s infinite; }',
    '[data-slot="sidebar"] { color: red; }'.repeat(THEME_CSS_MAX_LENGTH),
  ])("rejects unsafe or oversized CSS", (css) => {
    expect(() => sanitizeThemeCss(css)).toThrow();
  });
});
