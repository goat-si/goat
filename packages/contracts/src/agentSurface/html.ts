/** The reply column width shared by rendering and agent guidance. */
export const HTML_RENDER_COLUMN_WIDTH = 728;

/** Maximum frame height shared by clients and agent guidance. */
export const HTML_RENDER_MAX_FIT_HEIGHT = 20_000;

/** Agent-facing reference for the injected variables, used in tool descriptions. */
const HTML_RENDER_THEME_GUIDE = [
  "Use theme CSS variables on :root, not fixed colors:",
  "--background, --foreground, --muted, --card, --popover, --secondary, --border, --ring, --primary, --accent, --destructive, --warning, --success, --info, --code-background",
  "(most have a matching -foreground; accent, destructive, and warning also have -surface),",
  "--chart-1 to --chart-6, --radius, --font-sans, --font-mono.",
  "The base sheet sets background, text, and font.",
].join(" ");

/** Agent-facing layout rules for a page that sits inside a reply. */
const HTML_RENDER_LAYOUT_GUIDE = [
  `Frame width is reply width (${HTML_RENDER_COLUMN_WIDTH}px desktop, about 360px phones), on the thread background.`,
  "Leave html, body, and the outer element with no background color, no outer card, border, banner title, or side padding. This wins over any rule that sets a page background.",
  "A box that needs its own background gets 16px padding and var(--radius) corners. Give charts fixed pixel heights.",
  "Let content set the height. Do not use vh units or height:100% on html or body. Both are rejected or loop.",
].join(" ");

const PAGE_RULES =
  'Write one self-contained document with inline <style> and <script>. Local images written as absolute file paths (src="/abs/shot.png", CSS url(/abs/bg.webp), or a JS string) are inlined automatically; remote http(s) URLs, such as a CDN chart library, load as-is.';

/** What html_preview lists: under the description budget; the rest is in its guide. */
export const htmlPreviewDescription =
  "Render an HTML page in GOAT's headless browser and get its screenshot, content height and console output, to check a page before goat_html_render. Preview paints with GOAT's built-in light or dark palette, which can differ from the reader's theme.";

export const htmlPreviewGuide = `The result has a PNG screenshot, contentHeight (the height the page needs at this width), and the page's console output: log, info, warning, error, and uncaught exceptions, with stack traces pointing into page.html. console.log is a fine way to report your own checks. The first preview on a machine can report that GOAT is still installing its preview browser; call again a minute later. ${PAGE_RULES} The page gets the theme variables and layout described in goat_html_render. Preview lists local images it could not find in missingImages; goat_html_render refuses them.`;

/** What html_render lists: under the description budget; the rest is in its guide. */
export const htmlRenderDescription =
  "Show a finished HTML page (chart, table, diagram, mockup) inline in this thread, above your final reply; call it before writing that reply, and do not announce or restate the page there. Preview it with goat_html_preview first. Viewport-based heights are refused; let content set the height.";

export const htmlRenderGuide = `The reader already sees the page, so the reply adds only what the page doesn't say. GOAT fits the frame to the page's height at each reader's width. On mobile, a height below the page's contentHeight caps the frame there, and the rest scrolls inside it; web and desktop fit the whole page, up to ${HTML_RENDER_MAX_FIT_HEIGHT}px. ${PAGE_RULES} ${HTML_RENDER_LAYOUT_GUIDE} ${HTML_RENDER_THEME_GUIDE}`;
