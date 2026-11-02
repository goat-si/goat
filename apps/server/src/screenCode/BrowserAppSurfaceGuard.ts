/**
 * Refuses screen.app() input aimed at web content in a browser window. Pages are driven over CDP
 * through screen.tab(), which sees the DOM, origin grants and navigation; native browser UI such as
 * the remote debugging alert or a file sheet stays reachable through screen.app().
 * Not yet guarded: right_click, drag, scroll, hover and select_text.
 */

import type { ComputerUsePrimitiveReply, ScreenHostCall, ScreenRunError } from "@goat/contracts";
import * as Effect from "effect/Effect";
import { driverValue } from "./DesktopDriverReplies.ts";
import { desktopCallArgs } from "./DesktopInputPlan.ts";
import { stripPartialNote, structureProblem } from "./DesktopObserveDepth.ts";
import { listedOf } from "./DesktopObserveRead.ts";
import { parseTree } from "./DesktopTreeText.ts";

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

export interface BrowserSurfaceRead {
  readonly targets: ReadonlyMap<string, SurfaceTarget>;
  readonly focusedToken?: string | undefined;
}

export interface BrowserSurfaceHolder {
  readonly appId: string;
  readonly bundleId?: string | undefined;
  readonly snapshotId?: string | undefined;
  browserSurface?: Map<string, BrowserSurfaceRead> | undefined;
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
      `GOAT could not tell whether this ${app} element is part of a web page. Observe a browser dialog again before acting on it.`,
    );
  if (WEB_ROLES.has(role) || target.ancestors.some((node) => WEB_ROLES.has(bare(node.role))))
    return refusal(
      app,
      "web_content",
      `That element is web content in ${app}; screen.app() does not drive pages.`,
    );
  const native = target.ancestors.some(isNativeBoundary);
  if (!native && isAddressBar(target))
    return refusal(
      app,
      "address_bar",
      `That is ${app}'s address bar; screen.app() does not navigate pages.`,
    );
  if (native || target.ancestryComplete) return {};
  return refusal(
    app,
    "unverified_target",
    `GOAT could not tell whether this ${app} element is part of a web page. Observe a browser dialog again before acting on it.`,
  );
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const natural = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const string = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const nodeOf = (entry: Record<string, unknown>): SurfaceNode => ({
  role: string(entry.role) ?? "",
  subrole: string(entry.subrole),
});

export const readBrowserSurface = (
  state: Record<string, unknown>,
  whole: boolean,
): BrowserSurfaceRead => {
  const entries = Array.isArray(state.elements) ? state.elements.filter(record) : [];
  const byIndex = new Map<number, Record<string, unknown>>();
  for (const entry of entries) {
    const index = natural(entry.element_index);
    if (index !== undefined) byIndex.set(index, entry);
  }
  const raw = stripPartialNote(string(state.tree_markdown) ?? "").tree;
  const usable =
    whole &&
    state.degraded !== true &&
    raw.trim() !== "" &&
    structureProblem(raw, listedOf(entries)) === undefined;
  type Line = ReturnType<typeof parseTree>[number];
  const chains = new Map<number, { chain: Line[]; verified: boolean }>();
  const stack: Line[] = [];
  for (const line of parseTree(raw)) {
    while (stack.length > 0 && (stack.at(-1)?.depth ?? 0) >= line.depth) stack.pop();
    if (line.index !== undefined) {
      const chain = [...stack];
      const root = chain[0] ?? line;
      let nearest: number | undefined;
      const consistent = [...chain, line].every((node) => {
        if (node.index === undefined) return true;
        const entry = byIndex.get(node.index);
        const parent = natural(entry?.parent_index);
        const valid =
          entry !== undefined &&
          entry.role === node.role &&
          (parent === undefined || parent === nearest);
        nearest = node.index;
        return valid;
      });
      chains.set(line.index, {
        chain,
        verified:
          usable &&
          chain.every((node, i) => node.depth === 2 * i) &&
          line.depth === 2 * chain.length &&
          root.depth === 0 &&
          (bare(root.role) === "window" || bare(root.role) === "sheet") &&
          consistent,
      });
    }
    stack.push(line);
  }
  const targets = new Map<string, SurfaceTarget>();
  for (const entry of entries) {
    const token = string(entry.element_token);
    if (token === undefined) continue;
    const index = natural(entry.element_index);
    const text = index === undefined ? undefined : chains.get(index);
    const structured: SurfaceNode[] = [];
    const seen = new Set<number>();
    if (index !== undefined) seen.add(index);
    let parent = natural(entry.parent_index);
    for (let hops = 0; parent !== undefined && hops < 64 && !seen.has(parent); hops++) {
      seen.add(parent);
      const ancestor = byIndex.get(parent);
      if (ancestor === undefined) break;
      structured.push(nodeOf(ancestor));
      parent = natural(ancestor.parent_index);
    }
    const ancestors: SurfaceNode[] = text?.verified
      ? [...text.chain]
          .reverse()
          .map((line): SurfaceNode => ({
            role: line.role,
            subrole:
              line.index === undefined ? undefined : string(byIndex.get(line.index)?.subrole),
          }))
          .concat(structured)
      : [
          ...structured,
          ...(text?.chain.some((line) => WEB_ROLES.has(bare(line.role)))
            ? [{ role: "AXWebArea" }]
            : []),
        ];
    targets.set(token, {
      ...nodeOf(entry),
      label: string(entry.label),
      identifier: string(entry.identifier),
      ancestors,
      ancestryComplete: text?.verified === true,
    });
  }
  const focused = entries.filter((entry) => entry.focused === true);
  return {
    targets,
    focusedToken: focused.length === 1 ? string(focused[0]?.element_token) : undefined,
  };
};

const noteBrowserSurfaceRead = (
  bound: BrowserSurfaceHolder,
  tool: string,
  args: Record<string, unknown>,
  value: unknown,
): void => {
  if (
    !browserAppName(bound.appId, bound.bundleId) ||
    tool !== "get_window_state" ||
    args.include_accessibility_tree === false ||
    !record(value) ||
    typeof value.snapshot_id !== "string" ||
    (!Array.isArray(value.elements) && typeof value.tree_markdown !== "string")
  )
    return;
  const reads = (bound.browserSurface ??= new Map());
  reads.delete(value.snapshot_id);
  reads.set(
    value.snapshot_id,
    readBrowserSurface(value, args.query === undefined && args.since === undefined),
  );
  if (reads.size > 4) {
    const oldest = reads.keys().next().value;
    if (oldest !== undefined) reads.delete(oldest);
  }
};

export const browserSurfaceRefusal = (
  bound: BrowserSurfaceHolder,
  method: string,
  args: Record<string, unknown>,
  resolveToken: (element: Record<string, unknown>) => string | undefined,
  fresh: boolean,
): ScreenRunError | undefined => {
  if (!browserAppName(bound.appId, bound.bundleId) || !GUARDED_METHODS.has(method))
    return undefined;
  const read =
    fresh && bound.snapshotId !== undefined
      ? bound.browserSurface?.get(bound.snapshotId)
      : undefined;
  let token: string | undefined;
  if (record(args.elementRef)) {
    token = resolveToken(args.elementRef);
    if (token === undefined) return undefined;
  } else if (TEXT_METHODS.has(method) && method !== "set_value") token = read?.focusedToken;
  const refused = guardBrowserAppSurface({
    method,
    appId: bound.appId,
    bundleId: bound.bundleId,
    target: token === undefined ? undefined : read?.targets.get(token),
  }).refused;
  return refused === undefined
    ? undefined
    : {
        code: refused.code,
        effectStarted: false,
        nextStep: refused.nextStep,
        message: refused.message,
        detail: refused.reason,
      };
};

/** The refusal for one host call on a bound window, before anything reaches the driver. */
export const browserPageRefusal = (
  bound: BrowserSurfaceHolder,
  call: ScreenHostCall,
  resolveToken: (element: Record<string, unknown>) => string | undefined,
  fresh = true,
) => browserSurfaceRefusal(bound, call.method, desktopCallArgs(call.args), resolveToken, fresh);

/** A bound-window driver request that keeps each browser tree read it returns for the guard. */
export const recordBrowserSurfaceReads =
  <
    B extends BrowserSurfaceHolder,
    N,
    Rest extends ReadonlyArray<unknown>,
    A extends ComputerUsePrimitiveReply,
    E,
    R,
  >(
    request: (
      bound: B,
      needs: N,
      tool: string,
      args: Record<string, unknown>,
      ...rest: Rest
    ) => Effect.Effect<A, E, R>,
  ) =>
  (bound: B, needs: N, tool: string, args: Record<string, unknown>, ...rest: Rest) =>
    request(bound, needs, tool, args, ...rest).pipe(
      Effect.tap((reply) =>
        Effect.sync(() => noteBrowserSurfaceRead(bound, tool, args, driverValue(reply))),
      ),
    );
