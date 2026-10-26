/**
 * Finds the layer that blocks a page: a dialog, modal or fixed overlay covering most of the
 * viewport, such as a cookie banner or sign-in wall. Agents read it as one header line before a
 * snapshot, so they dismiss the overlay instead of clicking content it hides.
 *
 * The page samples a grid of points with elementsFromPoint and steps into open shadow roots,
 * because the document-level call stops at a shadow host. The decision runs here, in Node.
 *
 * @module blockingLayers
 */
import type { Page } from "playwright-core";
import type { SessionControl } from "./SessionControl.ts";

export interface LayerCandidate {
  readonly tagName: string;
  readonly role: string;
  readonly name: string;
  /** Share of sampled grid points this element was on top at, 0 to 1. */
  readonly coverage: number;
  readonly position: string;
  readonly pointerEvents: string;
  /** Computed z-index; "auto" when the element sets none. */
  readonly zIndex: string;
  readonly ariaModal: boolean;
  /** Page content lay beneath it at some sampled point. */
  readonly overContent: boolean;
  /** The document, its body, <main> or role=main: content, never an overlay. */
  readonly mainContent: boolean;
  readonly selectorHint: string;
}

export interface LayersReport {
  readonly blocking: LayerCandidate | null;
  readonly candidates: ReadonlyArray<LayerCandidate>;
  readonly viewport: { readonly width: number; readonly height: number };
}

export const BLOCKING_COVERAGE = 0.6;
const DEFAULT_GRID = 5;
const MAX_GRID = 10;
const MAX_NAME_LENGTH = 80;

/** Runs in the page with the grid size and returns plain data, never element handles. */
const LAYERS_SCRIPT = `(gridSize) => {
  const view = globalThis.visualViewport;
  const width = Math.round(view ? view.width : innerWidth);
  const height = Math.round(view ? view.height : innerHeight);
  const parentOf = (node) => {
    if (node.parentElement) return node.parentElement;
    const root = node.getRootNode && node.getRootNode();
    return root && root.host ? root.host : null;
  };
  const contains = (outer, node) => {
    for (let current = node; current; current = parentOf(current)) if (current === outer) return true;
    return false;
  };
  const topmost = (stack, x, y) => {
    let element = stack[0] || null;
    const seen = new Set();
    while (element && element.shadowRoot && !seen.has(element)) {
      seen.add(element);
      const root = element.shadowRoot;
      // Only a node of this very shadow tree, so a hit never escapes back to the host's document.
      const inner = root.elementsFromPoint(x, y).find((node) => node.getRootNode() === root);
      if (!inner) break;
      element = inner;
    }
    return element;
  };
  const isDialog = (element) => {
    const role = (element.getAttribute("role") || "").toLowerCase();
    return role === "dialog" || role === "alertdialog" || element.getAttribute("aria-modal") === "true";
  };
  const qualifies = (element) => {
    const rect = element.getBoundingClientRect();
    if (rect.width * rect.height < 0.5 * width * height) return false;
    const style = getComputedStyle(element);
    return (
      style.position === "fixed" ||
      (style.position === "absolute" && style.zIndex !== "auto") ||
      isDialog(element)
    );
  };
  // Content under the layer, outside it and outside its ancestors: an overlay over a page,
  // where an app shell has only the document beneath it.
  const coversContent = (layer, stack) =>
    stack.some(
      (node) =>
        node !== document.documentElement &&
        node !== document.body &&
        !contains(layer, node) &&
        !contains(node, layer),
    );
  // A hit anywhere inside an overlay counts for the outermost large layer over page content, so
  // an overlay split into panels is one layer, and an app shell or root around it is not chosen.
  const promote = (hit, stack) => {
    let overlay = null;
    let dialog = null;
    for (let node = hit; node && node.nodeType === 1; node = parentOf(node)) {
      if (!qualifies(node)) continue;
      if (coversContent(node, stack)) overlay = node;
      if (isDialog(node)) dialog = node;
    }
    return overlay || dialog || hit;
  };
  const collapse = (text) => (text || "").replace(/\\s+/g, " ").trim();
  const nameOf = (element) => {
    const label = collapse(element.getAttribute("aria-label"));
    if (label) return label;
    const ids = collapse(element.getAttribute("aria-labelledby"));
    const labelled = collapse(
      ids
        .split(" ")
        .map((id) => (id ? (document.getElementById(id) || {}).textContent : ""))
        .join(" "),
    );
    if (labelled) return labelled;
    const heading = element.querySelector("h1,h2,h3,h4,h5,h6");
    const headingText = heading ? collapse(heading.textContent) : "";
    if (headingText) return headingText;
    return collapse(element.innerText || element.textContent);
  };
  const hintOf = (element) => {
    if (element.id) return "#" + element.id;
    const tag = element.tagName.toLowerCase();
    const classes = [...element.classList].slice(0, 3);
    return classes.length > 0 ? tag + "." + classes.join(".") : tag;
  };
  const hits = new Map();
  if (width > 0 && height > 0) {
    for (let row = 0; row < gridSize; row++) {
      for (let column = 0; column < gridSize; column++) {
        const x = width * 0.05 + ((column + 0.5) * width * 0.9) / gridSize;
        const y = height * 0.05 + ((row + 0.5) * height * 0.9) / gridSize;
        const stack = document.elementsFromPoint(x, y);
        const hit = topmost(stack, x, y);
        if (!hit) continue;
        const layer = promote(hit, stack);
        const entry = hits.get(layer) || { count: 0, overContent: false };
        entry.count += 1;
        entry.overContent = entry.overContent || coversContent(layer, stack);
        hits.set(layer, entry);
      }
    }
  }
  const total = gridSize * gridSize;
  const candidates = [...hits].map(([element, { count, overContent }]) => {
    const style = getComputedStyle(element);
    const role = (element.getAttribute("role") || "").toLowerCase();
    const mainContent =
      element === document.documentElement ||
      element === document.body ||
      element.tagName === "MAIN" ||
      role === "main";
    return {
      tagName: element.tagName.toLowerCase(),
      role,
      // Content needs no name, and reading the whole body's text would force a full layout.
      name: mainContent ? "" : nameOf(element).slice(0, 200),
      coverage: count / total,
      position: style.position,
      pointerEvents: style.pointerEvents,
      zIndex: style.zIndex,
      ariaModal: element.getAttribute("aria-modal") === "true",
      overContent,
      mainContent,
      selectorHint: hintOf(element),
    };
  });
  return { viewport: { width, height }, candidates };
}`;

const isBlocking = (candidate: LayerCandidate) => {
  if (candidate.coverage < BLOCKING_COVERAGE || candidate.pointerEvents === "none") return false;
  if (candidate.role === "dialog" || candidate.role === "alertdialog" || candidate.ariaModal)
    return true;
  if (candidate.mainContent || !candidate.overContent) return false;
  if (candidate.position === "fixed") return true;
  // Apps often root themselves in an absolute full-page box; an overlay also stacks above.
  return candidate.position === "absolute" && candidate.zIndex !== "auto";
};

/** The widest candidate that blocks the page, or null when the content is reachable. */
export const pickBlocking = (candidates: ReadonlyArray<LayerCandidate>) =>
  candidates.toSorted((left, right) => right.coverage - left.coverage).find(isBlocking) ?? null;

export const layersHeader = (report: LayersReport) => {
  const blocking = report.blocking;
  if (blocking === null) return "@layers none";
  const name = blocking.name
    .replace(/\s+/g, " ")
    .replaceAll('"', "'")
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  const coverage = Math.round(blocking.coverage * 100);
  return `@layers blocking=${blocking.role || blocking.tagName} "${name}" coverage=${coverage}% hint=${blocking.selectorHint}`;
};

export const describeLayers = async (
  page: Pick<Page, "evaluate">,
  control: Pick<SessionControl, "observe">,
  options: { readonly grid?: number } = {},
): Promise<LayersReport> => {
  const grid =
    options.grid !== undefined && Number.isFinite(options.grid)
      ? Math.min(MAX_GRID, Math.max(1, Math.round(options.grid)))
      : DEFAULT_GRID;
  // Names are page text, so a private tab withholds them like any other observation.
  return control.observe(async () => {
    // Page-side code is passed as source: the server compiles without DOM types.
    const sampled = (await page.evaluate(`(${LAYERS_SCRIPT})(${grid})`)) as Omit<
      LayersReport,
      "blocking"
    >;
    return { ...sampled, blocking: pickBlocking(sampled.candidates) };
  });
};
