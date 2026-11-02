/**
 * Refuses screen.app() input aimed at web content in a browser window. Pages are driven over CDP
 * through screen.tab(), which sees the DOM, origin grants and navigation; native browser UI such as
 * the remote debugging alert or a file sheet stays reachable through screen.app().
 * Not yet guarded: right_click, drag, scroll and hover.
 */

const BROWSER_SURFACE_NEXT_STEP =
  "Use screen.tab() or screen.openTab({ url }) to navigate and interact with web pages over CDP.";

export interface SurfaceNode {
  readonly role: string;
  readonly subrole?: string | undefined;
}

export interface SurfaceTarget extends SurfaceNode {
  readonly label?: string | undefined;
  readonly identifier?: string | undefined;
  /** Nearest ancestor first. */
  readonly ancestors: readonly SurfaceNode[];
  /** False when the observed tree skipped or truncated nodes between the target and its window. */
  readonly ancestryComplete: boolean;
}

export interface BrowserSurfaceInput {
  readonly method: string;
  readonly appId: string;
  readonly bundleId?: string | undefined;
  /** The element the input lands on: the addressed element, or the focused one for keys. */
  readonly target?: SurfaceTarget | undefined;
}

export interface BrowserSurfaceRefusal {
  readonly code: "browser_surface_required";
  readonly nothingSent: true;
  readonly effectStarted: false;
  readonly reason: "web_content" | "address_bar" | "unverified_target";
  readonly app: string;
  readonly message: string;
  readonly nextStep: typeof BROWSER_SURFACE_NEXT_STEP;
}

const BROWSER_BUNDLES: ReadonlyMap<string, string> = new Map([
  ["com.google.chrome", "Google Chrome"],
  ["com.google.chrome.canary", "Google Chrome Canary"],
  ["com.brave.browser", "Brave Browser"],
  ["com.microsoft.edgemac", "Microsoft Edge"],
  ["company.thebrowser.browser", "Arc"],
  ["com.apple.safari", "Safari"],
  ["com.apple.safaritechnologypreview", "Safari Technology Preview"],
  ["org.mozilla.firefox", "Firefox"],
  ["org.chromium.chromium", "Chromium"],
]);
const BROWSER_NAMES: ReadonlySet<string> = new Set(
  [...BROWSER_BUNDLES.values()].map((name) => name.toLowerCase()),
);

const GUARDED_METHODS: ReadonlySet<string> = new Set([
  "click",
  "type_text",
  "set_value",
  "press_key",
]);
const TEXT_METHODS: ReadonlySet<string> = new Set(["type_text", "set_value", "press_key"]);
const WEB_ROLES: ReadonlySet<string> = new Set([
  "webarea",
  "documentweb",
  "document_web",
  "document web",
]);
const DIALOG_SUBROLES: ReadonlySet<string> = new Set(["dialog", "systemdialog"]);
const ADDRESS_ROLES: ReadonlySet<string> = new Set(["textfield", "combobox", "searchfield"]);
const ADDRESS_IDENTIFIERS: ReadonlySet<string> = new Set([
  "web_browser_address_and_search_field",
  "urlbar-input",
  "omnibox",
]);
const ADDRESS_LABELS: readonly string[] = [
  "address and search bar",
  "search or enter address",
  "search or enter website",
  "smart search field",
  "주소 및 검색창",
];

const bare = (role: string | undefined) => (role ?? "").trim().toLowerCase().replace(/^ax/, "");

export const browserAppName = (appId: string, bundleId?: string): string | undefined => {
  const byBundle = BROWSER_BUNDLES.get((bundleId ?? appId).trim().toLowerCase());
  if (byBundle !== undefined) return byBundle;
  const name = appId.trim().toLowerCase();
  return BROWSER_NAMES.has(name) ? appId.trim() : undefined;
};

/** Pages cannot create sheets or dialog-subrole windows; ARIA toolbars, menus and dialogs can. */
const isNativeBoundary = (node: SurfaceNode) =>
  bare(node.role) === "sheet" ||
  (bare(node.role) === "window" && DIALOG_SUBROLES.has(bare(node.subrole)));

const isAddressBar = (target: SurfaceTarget) => {
  if (!ADDRESS_ROLES.has(bare(target.role))) return false;
  if (ADDRESS_IDENTIFIERS.has((target.identifier ?? "").trim().toLowerCase())) return true;
  const label = (target.label ?? "").trim().toLowerCase();
  return ADDRESS_LABELS.some((known) => label.includes(known));
};

const refusal = (
  app: string,
  reason: BrowserSurfaceRefusal["reason"],
  message: string,
): { readonly refused: BrowserSurfaceRefusal } => ({
  refused: {
    code: "browser_surface_required",
    nothingSent: true,
    effectStarted: false,
    reason,
    app,
    message,
    nextStep: BROWSER_SURFACE_NEXT_STEP,
  },
});

export const guardBrowserAppSurface = (
  input: BrowserSurfaceInput,
): { readonly refused?: BrowserSurfaceRefusal } => {
  const app = browserAppName(input.appId, input.bundleId);
  if (app === undefined || !GUARDED_METHODS.has(input.method)) return {};
  const target = input.target;
  const role = bare(target?.role);
  if (target === undefined || role === "" || role === "unknown")
    return refusal(
      app,
      "unverified_target",
      `GOAT could not tell whether this ${app} element is part of a web page.`,
    );
  if (WEB_ROLES.has(role) || target.ancestors.some((node) => WEB_ROLES.has(bare(node.role))))
    return refusal(
      app,
      "web_content",
      `That element is web content in ${app}; screen.app() does not drive pages.`,
    );
  const native = target.ancestors.some(isNativeBoundary);
  if (!native && TEXT_METHODS.has(input.method) && isAddressBar(target))
    return refusal(
      app,
      "address_bar",
      `That is ${app}'s address bar; screen.app() does not navigate pages.`,
    );
  if (native || target.ancestryComplete) return {};
  return refusal(
    app,
    "unverified_target",
    `GOAT could not tell whether this ${app} element is part of a web page.`,
  );
};
