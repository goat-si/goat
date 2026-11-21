import { THEME_CSS_MAX_LENGTH } from "@goat/contracts";

let revision = 0;
let sheet: CSSStyleSheet | null = null;

export async function applyThemeCss(css: string | undefined): Promise<void> {
  const current = ++revision;
  if (typeof document === "undefined" || typeof CSSStyleSheet === "undefined") return;
  if (sheet !== null) sheet.replaceSync("");
  if (!css) return;
  if (css.length > THEME_CSS_MAX_LENGTH) throw new Error("Theme CSS is too large");
  const { sanitizeThemeCss } = await import("@goat/shared/themeCssSanitizer");
  const scoped = sanitizeThemeCss(css);
  if (current !== revision) return;
  if (sheet === null) {
    sheet = new CSSStyleSheet();
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  }
  sheet.replaceSync(scoped);
}
