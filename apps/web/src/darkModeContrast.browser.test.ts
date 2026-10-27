import "~/index.css";
import indexCss from "~/index.css?raw";
import { GOAT_DARK_THEME_COLORS, type ThemeColorRole } from "@goat/shared/themePalettes";
import { afterEach, describe, expect, it } from "vite-plus/test";

// Contrast is measured on the pixels the browser paints: each token resolves
// through the real stylesheet, translucent layers composite in order on a
// canvas, and WCAG 2.2 relative luminance is computed from the result.

const canvas = document.createElement("canvas");
canvas.width = 1;
canvas.height = 1;
const context = canvas.getContext("2d", { willReadFrequently: true })!;

function paint(layers: ReadonlyArray<string>): [number, number, number] {
  context.clearRect(0, 0, 1, 1);
  context.fillStyle = "#000";
  context.fillRect(0, 0, 1, 1);
  for (const layer of layers) {
    context.fillStyle = layer;
    context.fillRect(0, 0, 1, 1);
  }
  const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
  return [red!, green!, blue!];
}

function luminance([red, green, blue]: [number, number, number]): number {
  const [r, g, b] = [red, green, blue].map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(foreground: [number, number, number], background: [number, number, number]) {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light! + 0.05) / (dark! + 0.05);
}

const SENTINEL = "rgb(1, 2, 3)";
let host: HTMLElement | undefined;

function mount(appearance: "light" | "dark", scope: "root" | "sidebar") {
  document.documentElement.classList.toggle("dark", appearance === "dark");
  delete document.documentElement.dataset.themeId;
  host?.remove();
  host = document.createElement("div");
  host.style.color = SENTINEL;
  if (scope === "sidebar") host.dataset.appSidebar = "";
  document.body.append(host);
  return host;
}

function resolve(scope: HTMLElement, value: string): string {
  const probe = document.createElement("span");
  probe.style.color = value;
  scope.append(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  return resolved;
}

afterEach(() => {
  host?.remove();
  host = undefined;
  document.documentElement.classList.remove("dark");
});

type Pair = {
  readonly label: string;
  readonly scope: "root" | "sidebar";
  readonly foreground: string;
  readonly background: ReadonlyArray<string>;
  readonly minimum: number;
};

const muted = (alpha: number) =>
  `color-mix(in oklab, var(--contrast-muted-foreground) ${alpha}%, transparent)`;

// The dropdown-glass utility fill, seen over a card: the lightest surface a
// menu commonly opens above.
const MENU_OVER_CARD = [
  "var(--background)",
  "var(--card)",
  "color-mix(in srgb, var(--popover) 18%, color-mix(in srgb, var(--popover) var(--glass-surface-opacity), transparent))",
];

// Backgrounds list every layer from the canvas up, so translucent fills such as
// --secondary and --accent are measured where they actually sit.
const DARK_PAIRS: ReadonlyArray<Pair> = [
  {
    label: "text / canvas",
    scope: "root",
    foreground: "var(--contrast-foreground)",
    background: ["var(--background)"],
    minimum: 4.5,
  },
  {
    label: "text / card",
    scope: "root",
    foreground: "var(--contrast-card-foreground)",
    background: ["var(--background)", "var(--card)"],
    minimum: 4.5,
  },
  {
    label: "text / popover",
    scope: "root",
    foreground: "var(--contrast-popover-foreground)",
    background: ["var(--background)", "var(--popover)"],
    minimum: 4.5,
  },
  {
    label: "text / secondary",
    scope: "root",
    foreground: "var(--contrast-secondary-foreground)",
    background: ["var(--background)", "var(--secondary)"],
    minimum: 4.5,
  },
  {
    label: "text / accent",
    scope: "root",
    foreground: "var(--contrast-accent-foreground)",
    background: ["var(--background)", "var(--accent)"],
    minimum: 4.5,
  },
  {
    label: "message / message surface",
    scope: "root",
    foreground: "var(--contrast-message-foreground)",
    background: ["var(--background)", "var(--message-surface)"],
    minimum: 4.5,
  },
  {
    label: "muted / canvas",
    scope: "root",
    foreground: "var(--contrast-muted-foreground)",
    background: ["var(--background)"],
    minimum: 4.5,
  },
  {
    label: "muted / card",
    scope: "root",
    foreground: "var(--contrast-muted-foreground)",
    background: ["var(--background)", "var(--card)"],
    minimum: 4.5,
  },
  {
    label: "muted / popover",
    scope: "root",
    foreground: "var(--contrast-muted-foreground)",
    background: ["var(--background)", "var(--popover)"],
    minimum: 4.5,
  },
  {
    label: "muted / muted surface",
    scope: "root",
    foreground: "var(--contrast-muted-foreground)",
    background: ["var(--background)", "var(--muted)"],
    minimum: 4.5,
  },
  {
    label: "muted / accent (hover)",
    scope: "root",
    foreground: "var(--contrast-muted-foreground)",
    background: ["var(--background)", "var(--accent)"],
    minimum: 4.5,
  },
  {
    label: "muted 80% / canvas",
    scope: "root",
    foreground: muted(80),
    background: ["var(--background)"],
    minimum: 4.5,
  },
  {
    label: "muted 70% / canvas",
    scope: "root",
    foreground: muted(70),
    background: ["var(--background)"],
    minimum: 3,
  },
  {
    // The dark floor for any muted text or icon that carries information:
    // lighter alphas (40-55%) step up to 60% under dark: in their components.
    label: "muted 60% / canvas",
    scope: "root",
    foreground: muted(60),
    background: ["var(--background)"],
    minimum: 3,
  },
  {
    // Labels on interactive rows (branch badges, sidebar thread times) sit on
    // lighter hover/selected fills, so they step up to 70% instead.
    label: "muted 70% / highlighted menu item",
    scope: "root",
    foreground: muted(70),
    background: [...MENU_OVER_CARD, "var(--accent)"],
    minimum: 3,
  },
  {
    label: "muted 70% / selected menu item",
    scope: "root",
    foreground: muted(70),
    background: [
      ...MENU_OVER_CARD,
      "color-mix(in oklab, var(--contrast-foreground) 8%, transparent)",
    ],
    minimum: 3,
  },
  {
    label: "muted 50% / canvas (separators, illustrations, disabled)",
    scope: "root",
    foreground: muted(50),
    background: ["var(--background)"],
    minimum: 2.5,
  },
  {
    label: "placeholder / canvas",
    scope: "root",
    foreground: "var(--contrast-placeholder)",
    background: ["var(--background)"],
    minimum: 4.5,
  },
  {
    label: "placeholder / composer",
    scope: "root",
    foreground: "var(--contrast-placeholder)",
    background: ["var(--background)", "var(--goat-composer-fill)"],
    minimum: 4.5,
  },
  {
    label: "secondary label / card",
    scope: "root",
    foreground: "var(--contrast-secondary-label)",
    background: ["var(--background)", "var(--card)"],
    minimum: 4.5,
  },
  {
    label: "muted icon / canvas",
    scope: "root",
    foreground: "var(--contrast-icon-muted)",
    background: ["var(--background)"],
    minimum: 3,
  },
  {
    label: "code / code block",
    scope: "root",
    foreground: "var(--code-foreground)",
    background: ["var(--background)", "var(--code-background)"],
    minimum: 4.5,
  },
  // The dimmest pierre-dark syntax colors (punctuation, comments) are fixed by
  // that theme, so the code ground is what keeps them readable.
  {
    label: "syntax punctuation / code block",
    scope: "root",
    foreground: "#636363",
    background: ["var(--background)", "var(--code-background)"],
    minimum: 3,
  },
  {
    label: "syntax comment / code block",
    scope: "root",
    foreground: "#737373",
    background: ["var(--background)", "var(--code-background)"],
    minimum: 4,
  },
  {
    label: "link (info) / canvas",
    scope: "root",
    foreground: "var(--info-foreground)",
    background: ["var(--background)"],
    minimum: 4.5,
  },
  {
    label: "success / canvas",
    scope: "root",
    foreground: "var(--success-foreground)",
    background: ["var(--background)"],
    minimum: 4.5,
  },
  {
    label: "warning / canvas",
    scope: "root",
    foreground: "var(--warning-foreground)",
    background: ["var(--background)"],
    minimum: 4.5,
  },
  {
    label: "error / canvas",
    scope: "root",
    foreground: "var(--error-foreground)",
    background: ["var(--background)"],
    minimum: 4.5,
  },
  {
    label: "error / error surface",
    scope: "root",
    foreground: "var(--error-foreground)",
    background: ["var(--background)", "var(--error-surface)"],
    minimum: 4.5,
  },
  {
    label: "merged / canvas",
    scope: "root",
    foreground: "var(--merged-foreground)",
    background: ["var(--background)"],
    minimum: 4.5,
  },
  {
    label: "update / update surface",
    scope: "root",
    foreground: "var(--update-foreground)",
    background: ["var(--background)", "var(--update-surface)"],
    minimum: 4.5,
  },
  {
    label: "PR open / canvas",
    scope: "root",
    foreground: "var(--color-pr-open)",
    background: ["var(--background)"],
    minimum: 4.5,
  },
  {
    label: "bot bubble text / bubble",
    scope: "root",
    foreground: "var(--goat-bubble-in-foreground)",
    background: ["var(--goat-bubble-in)"],
    minimum: 4.5,
  },
  {
    label: "primary button text / primary",
    scope: "root",
    foreground: "var(--primary-foreground)",
    background: ["var(--primary)"],
    minimum: 4.5,
  },
  {
    label: "focus ring / canvas",
    scope: "root",
    foreground: "var(--ring)",
    background: ["var(--background)"],
    minimum: 3,
  },
  {
    label: "sidebar text / sidebar",
    scope: "sidebar",
    foreground: "var(--contrast-sidebar-foreground)",
    background: ["var(--sidebar)"],
    minimum: 4.5,
  },
  {
    label: "sidebar muted / sidebar",
    scope: "sidebar",
    foreground: "var(--contrast-sidebar-muted-foreground)",
    background: ["var(--sidebar)"],
    minimum: 4.5,
  },
  {
    label: "sidebar muted / selected row",
    scope: "sidebar",
    foreground: "var(--contrast-sidebar-muted-foreground)",
    background: ["var(--sidebar)", "var(--sidebar-row-selected)"],
    minimum: 4.5,
  },
  {
    label: "sidebar muted 70% / sidebar",
    scope: "sidebar",
    foreground: muted(70),
    background: ["var(--sidebar)"],
    minimum: 3,
  },
  {
    label: "sidebar muted 70% / hovered row",
    scope: "sidebar",
    foreground: muted(70),
    background: ["var(--sidebar)", "var(--sidebar-row-hover)"],
    minimum: 3,
  },
  {
    label: "sidebar muted 70% / active row",
    scope: "sidebar",
    foreground: muted(70),
    background: ["var(--sidebar)", "var(--sidebar-row-active)"],
    minimum: 3,
  },
  {
    label: "sidebar icon / sidebar",
    scope: "sidebar",
    foreground: "var(--sidebar-icon-color)",
    background: ["var(--sidebar)"],
    minimum: 3,
  },
];

// Hairlines separate regions that already differ in fill, so they are held to a
// visible step rather than the 3:1 a lone control boundary would need.
const DARK_HAIRLINES: ReadonlyArray<Pair> = [
  {
    label: "border / canvas",
    scope: "root",
    foreground: "var(--contrast-border)",
    background: ["var(--background)"],
    minimum: 1.3,
  },
  {
    label: "input border / canvas",
    scope: "root",
    foreground: "var(--contrast-input)",
    background: ["var(--background)"],
    minimum: 1.45,
  },
  {
    label: "card / canvas",
    scope: "root",
    foreground: "var(--card)",
    background: ["var(--background)"],
    minimum: 1.08,
  },
  {
    label: "sidebar border / sidebar",
    scope: "sidebar",
    foreground: "var(--contrast-sidebar-border)",
    background: ["var(--sidebar)"],
    minimum: 1.3,
  },
];

function measure(pair: Pair): number {
  const scope = mount("dark", pair.scope);
  const background = pair.background.map((layer) => resolve(scope, layer));
  return contrast(paint([...background, resolve(scope, pair.foreground)]), paint(background));
}

describe("default dark theme contrast", () => {
  it.each([...DARK_PAIRS, ...DARK_HAIRLINES])("$label meets $minimum:1", (pair) => {
    const ratio = measure(pair);
    console.info(`[contrast] ${pair.label}: ${ratio.toFixed(2)}`);
    expect(ratio).toBeGreaterThanOrEqual(pair.minimum);
  });
});

const TOKEN_NAMES = [...new Set(indexCss.match(/--[a-z][\w-]*(?=\s*:)/g) ?? [])].toSorted();

function resolvedColorTokens(scope: "root" | "sidebar"): string {
  const element = mount("light", scope);
  const lines: string[] = [];
  for (const name of TOKEN_NAMES) {
    const resolved = resolve(element, `var(${name})`);
    if (resolved !== SENTINEL) lines.push(`${name}: ${resolved}`);
  }
  return lines.join("\n");
}

describe("default light theme", () => {
  // The dark fix must leave every light color byte-identical.
  it.each(["root", "sidebar"] as const)("keeps every %s color token", (scope) => {
    expect(resolvedColorTokens(scope)).toMatchSnapshot();
  });
});

// Mobile, the theme editor and HTML renders read the shared mirror instead of
// this stylesheet, so it must match what the stylesheet paints.
const MIRRORED_ROLES: ReadonlyArray<readonly [ThemeColorRole, "root" | "sidebar", string]> = [
  ["canvas", "root", "var(--background)"],
  ["surface", "root", "var(--card)"],
  ["surfaceRaised", "root", "var(--surface-raised)"],
  ["surfaceOverlay", "root", "var(--popover)"],
  ["text", "root", "var(--foreground)"],
  ["textMuted", "root", "var(--muted-foreground)"],
  ["mutedForeground", "root", "var(--muted-foreground)"],
  ["border", "root", "var(--border)"],
  ["input", "root", "var(--input)"],
  ["secondary", "root", "var(--secondary)"],
  ["muted", "root", "var(--muted)"],
  ["accentSurface", "root", "var(--accent)"],
  ["messageSurface", "root", "var(--message-surface)"],
  ["errorSurface", "root", "var(--error-surface)"],
  ["warningSurface", "root", "var(--warning-surface)"],
  ["updateSurface", "root", "var(--update-surface)"],
  ["codeBackground", "root", "var(--code-background)"],
  ["sidebar", "sidebar", "var(--sidebar)"],
  ["sidebarForeground", "sidebar", "var(--sidebar-foreground)"],
  ["sidebarMutedForeground", "sidebar", "var(--sidebar-muted-foreground)"],
  ["sidebarControlSurface", "sidebar", "var(--sidebar-control-surface)"],
  ["sidebarRowHover", "sidebar", "var(--sidebar-row-hover)"],
  ["sidebarRowActive", "sidebar", "var(--sidebar-row-active)"],
  ["sidebarRowSelected", "sidebar", "var(--sidebar-row-selected)"],
  ["sidebarBorder", "sidebar", "var(--sidebar-border)"],
];

describe("shared dark palette mirror", () => {
  it.each(MIRRORED_ROLES)("%s matches the stylesheet", (role, scope, token) => {
    const element = mount("dark", scope);
    const ground = resolve(element, scope === "sidebar" ? "var(--sidebar)" : "var(--background)");
    const painted = paint([ground, resolve(element, token)]);
    const mirrored = paint([GOAT_DARK_THEME_COLORS[role]]);
    painted.forEach((channel, index) =>
      expect(Math.abs(channel - mirrored[index]!)).toBeLessThanOrEqual(1),
    );
  });
});
