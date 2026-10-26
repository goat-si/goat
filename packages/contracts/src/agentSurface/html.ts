/** The reply column width shared by rendering and agent guidance. */
export const HTML_RENDER_COLUMN_WIDTH = 728;

/** Maximum frame height shared by clients and agent guidance. */
export const HTML_RENDER_MAX_FIT_HEIGHT = 20_000;

/** Agent-facing reference for the injected variables, used in tool descriptions. */
const HTML_RENDER_THEME_GUIDE = [
  "GOAT injects its active theme as CSS custom properties on :root, and they follow the user's theme and light/dark mode live:",
  "--background (page background, identical to the thread around the frame), --foreground, --muted, --muted-foreground,",
  "--card, --card-foreground, --popover, --popover-foreground, --secondary, --secondary-foreground, --border, --input, --ring,",
  "--primary, --primary-foreground (solid buttons), --accent, --accent-foreground (brand accent), --accent-surface, --accent-surface-foreground,",
  "--destructive, --destructive-foreground, --destructive-surface, --warning, --warning-foreground, --warning-surface,",
  "--success, --success-foreground, --info, --info-foreground, --code-background, --code-foreground,",
  "--chart-1 … --chart-6 (categorical series for charts), --radius, --font-sans, --font-mono.",
  "The base stylesheet sets html background/color/font from these, body margin to 0, and hides the page's scrollbar; your own CSS overrides it.",
].join(" ");

/** Agent-facing layout rules for a page that sits inside a reply. */
const HTML_RENDER_LAYOUT_GUIDE = [
  `The frame is borderless on the thread's background, as wide as the reply column (${HTML_RENDER_COLUMN_WIDTH}px on desktop by default, wider if the reader widens chat, about 360px on phones), and its left edge lines up with your reply text.`,
  "The page sits on the thread's own background, so by default leave html, body, and the outermost element with no background color. This overrides general style preferences such as a fixed black page background.",
  "Use a fluid width with no horizontal padding on the outermost element, and no outer card, border, or banner title: the page is part of your reply.",
  "If a box needs its own background (a mock of a specific screen, a panel that must stand apart), give it at least 16px of padding on every side and var(--radius) corners, so content never touches its edge.",
  "Give charts fixed pixel heights rather than heights that scale with width.",
  "Let content set the page's height. Avoid viewport-based heights such as 100vh or height:100% on html or body; the frame grows to fit the page, so they can make it grow again and again.",
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
