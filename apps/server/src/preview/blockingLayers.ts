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
import type { Frame, Page } from "playwright-core";
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
  /** aria-modal, or a native dialog opened with showModal(): the rest of the page is inert. */
  readonly ariaModal: boolean;
  /** In the browser's top layer as an open popover or a modal dialog, above any z-index. */
  readonly topLayer?: boolean;
  /** Page content lay beneath it at some sampled point. */
  readonly overContent: boolean;
  /** The document, its body, <main> or role=main: content, never an overlay. */
  readonly mainContent: boolean;
  /** Holds no element or text of its own, like the scrim behind a modal. */
  readonly empty: boolean;
  /** The viewport edge a fixed or sticky bar spans, such as a cookie banner's "bottom"; "" when none. */
  readonly edge: "" | "top" | "bottom" | "left" | "right";
  /** Its id, class or accessible name speaks of cookies or consent. */
  readonly consent: boolean;
  readonly selectorHint: string;
}

export interface LayersReport {
  readonly blocking: LayerCandidate | null;
  readonly candidates: ReadonlyArray<LayerCandidate>;
  readonly viewport: { readonly width: number; readonly height: number };
}

const BLOCKING_COVERAGE = 0.6;
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
  // :modal is a dialog opened with showModal(); it makes the rest of the page inert without ARIA.
  const matches = (element, selector) => {
    try {
      return element.matches(selector);
    } catch {
      return false;
    }
  };
  const roleOf = (element) =>
    (element.getAttribute("role") || "").toLowerCase() || (element.tagName === "DIALOG" ? "dialog" : "");
  const isDialog = (element) => {
    const role = roleOf(element);
    return role === "dialog" || role === "alertdialog" || element.getAttribute("aria-modal") === "true";
  };
  const qualifies = (element) => {
    const rect = element.getBoundingClientRect();
    if (rect.width * rect.height < 0.5 * width * height) return false;
    const style = getComputedStyle(element);
    // A click-through wrapper holds an overlay without being one; the overlay inside decides.
    if (style.pointerEvents === "none") return false;
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
  // A small modal filled by a wrapper or button still counts as the modal, not the child hit.
  const isModal = (element) =>
    roleOf(element) === "alertdialog" ||
    element.getAttribute("aria-modal") === "true" ||
    matches(element, ":modal");
  const promote = (hit, stack) => {
    let overlay = null;
    let dialog = null;
    let modal = null;
    let topLayer = null;
    for (let node = hit; node && node.nodeType === 1; node = parentOf(node)) {
      if (!modal && isModal(node)) modal = node;
      // An open popover is drawn above the page however it is positioned.
      if (!topLayer && matches(node, ":popover-open")) topLayer = node;
      if (!qualifies(node)) continue;
      if (coversContent(node, stack)) overlay = node;
      if (isDialog(node)) dialog = node;
    }
    return overlay || dialog || modal || topLayer || hit;
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
    const text = collapse(element.innerText || element.textContent);
    if (text) return text;
    // A consent wall often holds nothing but a cross-origin frame; its title says what it asks.
    const frame = element.querySelector("iframe[title], iframe[aria-label]");
    return frame ? collapse(frame.getAttribute("aria-label") || frame.getAttribute("title")) : "";
  };
  const hintOf = (element) => {
    if (element.id) return "#" + element.id;
    const tag = element.tagName.toLowerCase();
    const classes = [...element.classList].slice(0, 3);
    return classes.length > 0 ? tag + "." + classes.join(".") : tag;
  };
  const hits = new Map();
  // A bar docked to an edge lies outside the grid, which spans 5% to 95% of the viewport.
  const docked = (hit) => {
    for (let node = hit; node && node.nodeType === 1; node = parentOf(node)) {
      const position = getComputedStyle(node).position;
      if (position === "fixed" || position === "sticky") return node;
    }
    return null;
  };
  const edgeOf = (element, position) => {
    if (position !== "fixed" && position !== "sticky") return "";
    const rect = element.getBoundingClientRect();
    if (rect.width >= 0.9 * width) {
      if (rect.bottom >= height - 2 && rect.top > 0) return "bottom";
      if (rect.top <= 2 && rect.bottom < height) return "top";
    }
    if (rect.height >= 0.9 * height) {
      if (rect.right >= width - 2 && rect.left > 0) return "right";
      if (rect.left <= 2 && rect.right < width) return "left";
    }
    return "";
  };
  const edgePoints = [];
  if (width > 0 && height > 0) {
    for (let step = 0; step < gridSize; step++) {
      const x = width * 0.05 + ((step + 0.5) * width * 0.9) / gridSize;
      const y = height * 0.05 + ((step + 0.5) * height * 0.9) / gridSize;
      edgePoints.push([x, height * 0.025], [x, height * 0.975], [width * 0.025, y], [width * 0.975, y]);
    }
  }
  for (const [x, y] of edgePoints) {
    const hit = topmost(document.elementsFromPoint(x, y), x, y);
    const bar = hit && docked(hit);
    if (bar && !hits.has(bar)) hits.set(bar, { count: 0, overContent: false });
  }
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
    const rect = element.getBoundingClientRect();
    const visible =
      Math.max(0, Math.min(rect.right, width) - Math.max(rect.left, 0)) *
      Math.max(0, Math.min(rect.bottom, height) - Math.max(rect.top, 0));
    const role = roleOf(element);
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
      // A bar only the edge pass found has no grid share; its visible area stands in.
      coverage: count > 0 ? count / total : visible / (width * height),
      position: style.position,
      pointerEvents: style.pointerEvents,
      zIndex: style.zIndex,
      ariaModal: element.getAttribute("aria-modal") === "true" || matches(element, ":modal"),
      topLayer: matches(element, ":modal") || matches(element, ":popover-open"),
      overContent,
      mainContent,
      empty: element.childElementCount === 0 && !collapse(element.textContent),
      edge: mainContent ? "" : edgeOf(element, style.position),
      consent:
        !mainContent &&
        /cookie|consent|gdpr/i.test(
          [element.id, element.getAttribute("class"), collapse(element.getAttribute("aria-label"))].join(" "),
        ),
      selectorHint: hintOf(element),
    };
  });
  return { viewport: { width, height }, candidates };
}`;

/** aria-modal or alertdialog declares the rest of the page inert, however small its own box. */
const isModal = (candidate: LayerCandidate) =>
  candidate.role === "alertdialog" || candidate.ariaModal;

/**
 * A consent bar docked across an edge covers little but sits over the page until answered. A
 * docked bar counts only as a dialog or by naming cookies or consent, so a site header, nav bar
 * or toolbar, which are docked too, never does.
 */
const isConsentBar = (candidate: LayerCandidate) =>
  candidate.edge !== "" && (candidate.role === "dialog" || isModal(candidate) || candidate.consent);

const isBlocking = (candidate: LayerCandidate) => {
  if (candidate.pointerEvents === "none") return false;
  if (isModal(candidate)) return true;
  if (candidate.coverage < BLOCKING_COVERAGE)
    return !candidate.mainContent && isConsentBar(candidate);
  if (candidate.role === "dialog") return true;
  if (candidate.mainContent) return false;
  // Nothing on the page can stack above the top layer, whatever lies beneath it.
  if (candidate.topLayer === true) return true;
  // A scrim holds nothing itself, so it blocks even where the page beneath it is blank.
  if (!candidate.overContent)
    return candidate.empty && candidate.position === "fixed" && candidate.zIndex !== "auto";
  if (candidate.position === "fixed") return true;
  // Apps often root themselves in an absolute full-page box; an overlay also stacks above.
  return candidate.position === "absolute" && candidate.zIndex !== "auto";
};

/** The widest candidate that blocks the page, or null when the content is reachable. */
export const pickBlocking = (candidates: ReadonlyArray<LayerCandidate>) => {
  const blocking = candidates
    .toSorted((left, right) => right.coverage - left.coverage)
    .filter(isBlocking);
  // A scrim has no name or control to act on; the modal over it does.
  const widest = blocking[0];
  return (widest?.empty ? blocking.find(isModal) : undefined) ?? widest ?? null;
};

/** Page-controlled text, kept to one line so it cannot add lines to the header. */
const oneLine = (text: string) => text.replace(/\s+/g, " ").replaceAll('"', "'").trim();

export const layersHeader = (report: LayersReport) => {
  const blocking = report.blocking;
  if (blocking === null) return "@layers none";
  const name = blocking.name
    .replace(/\s+/g, " ")
    .replaceAll('"', "'")
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  const coverage = Math.round(blocking.coverage * 100);
  const kind = oneLine(blocking.role || blocking.tagName);
  const edge =
    blocking.coverage < BLOCKING_COVERAGE && blocking.edge ? ` edge=${blocking.edge}` : "";
  return `@layers blocking=${kind} "${name}" coverage=${coverage}%${edge} hint=${oneLine(blocking.selectorHint)}`;
};

type LayersPage = Pick<Page, "evaluate"> & Partial<Pick<Page, "frames" | "mainFrame">>;
type Sampled = Omit<LayersReport, "blocking">;

// Page-side code is passed as source: the server compiles without DOM types.
const sampleIn = (target: Pick<Page, "evaluate">, grid: number) =>
  target.evaluate(`(${LAYERS_SCRIPT})(${grid})`) as Promise<Sampled>;

type HitRect = {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
};
type HitNode = {
  getBoundingClientRect(): HitRect;
  getRootNode(): { elementFromPoint(x: number, y: number): unknown };
};

/**
 * Runs in the page: the share of a frame element's part inside its document's viewport that the
 * document draws on top, by hit-testing a grid. Clipping by an overflow box, a cover over it, or
 * a fixed frame escaping its box all count as the browser paints them.
 */
const drawnShare = (element: HitNode): number => {
  // Inside the function: the page receives only its source.
  const grid = 5;
  const view = globalThis as unknown as { innerWidth: number; innerHeight: number };
  const rect = element.getBoundingClientRect();
  const left = Math.max(rect.left, 0);
  const top = Math.max(rect.top, 0);
  const right = Math.min(rect.right, view.innerWidth);
  const bottom = Math.min(rect.bottom, view.innerHeight);
  if (right <= left || bottom <= top) return 0;
  const root = element.getRootNode();
  let hits = 0;
  for (let column = 0; column < grid; column++)
    for (let row = 0; row < grid; row++) {
      const x = left + ((column + 0.5) * (right - left)) / grid;
      const y = top + ((row + 0.5) * (bottom - top)) / grid;
      if (root.elementFromPoint(x, y) === element) hits++;
    }
  return hits / (grid * grid);
};

/**
 * The part of the viewport a frame shows: its box, in the top page's coordinates with transforms
 * applied, clipped by every frame around it and scaled by how much of each frame element its
 * document actually draws. Null when it cannot be measured.
 */
const visibleArea = async (frame: Frame, viewport: Sampled["viewport"]) => {
  let left = 0;
  let top = 0;
  let right = viewport.width;
  let bottom = viewport.height;
  let drawn = 1;
  for (let current: Frame | null = frame; current?.parentFrame();) {
    const measured = await current
      .frameElement()
      .then(async (element) => {
        const box = await element.boundingBox();
        return box === null ? null : { box, share: await element.evaluate(drawnShare) };
      })
      .catch(() => null);
    if (measured === null) return null;
    const { box, share } = measured;
    left = Math.max(left, box.x);
    top = Math.max(top, box.y);
    right = Math.min(right, box.x + box.width);
    bottom = Math.min(bottom, box.y + box.height);
    drawn *= share;
    current = current.parentFrame();
  }
  return Math.max(0, right - left) * Math.max(0, bottom - top) * drawn;
};

/**
 * A modal inside an iframe blocks that frame's part of the page. Only modals count there, so a
 * frame's own header or full-frame app root never reads as blocking the page, and a frame out of
 * sight blocks nothing.
 */
const frameModals = async (page: LayersPage, grid: number, viewport: Sampled["viewport"]) => {
  if (typeof page.frames !== "function" || typeof page.mainFrame !== "function") return [];
  const main = page.mainFrame();
  const area = viewport.width * viewport.height;
  const found = await Promise.all(
    page
      .frames()
      .filter((frame) => frame !== main)
      .map(async (frame) => {
        const [sampled, visible] = await Promise.all([
          sampleIn(frame, grid).catch(() => null),
          visibleArea(frame, viewport),
        ]);
        if (!sampled || !Array.isArray(sampled.candidates) || !visible || area <= 0) return [];
        const share = visible / area;
        return sampled.candidates.filter(isModal).map((candidate) => ({
          ...candidate,
          coverage: Math.min(1, candidate.coverage * share),
          selectorHint: `iframe ${candidate.selectorHint}`,
        }));
      }),
  );
  return found.flat();
};

const sampleLayers = async (page: LayersPage, grid: number): Promise<Sampled> => {
  const sampled = await sampleIn(page, grid);
  if (!sampled || !Array.isArray(sampled.candidates)) return sampled;
  const framed = await frameModals(page, grid, sampled.viewport);
  return framed.length === 0
    ? sampled
    : { ...sampled, candidates: [...sampled.candidates, ...framed] };
};

export const describeLayers = async (
  page: LayersPage,
  control: Pick<SessionControl, "observe">,
  options: { readonly grid?: number } = {},
): Promise<LayersReport> => {
  const grid =
    options.grid !== undefined && Number.isFinite(options.grid)
      ? Math.min(MAX_GRID, Math.max(1, Math.round(options.grid)))
      : DEFAULT_GRID;
  // Names are page text, so a private tab withholds them like any other observation.
  return control.observe(async () => {
    const sampled = await sampleLayers(page, grid);
    return { ...sampled, blocking: pickBlocking(sampled.candidates) };
  });
};

/**
 * Samples the page's layers and formats the @layers header line for a snapshot. Falls back to
 * @layers none when the page stub has no layer candidates.
 */
export const readLayersHeader = async (page: LayersPage, grid = DEFAULT_GRID): Promise<string> => {
  const sampled = await sampleLayers(page, grid).catch(() => null);
  if (!sampled || !Array.isArray(sampled.candidates)) return "@layers none";
  return layersHeader({ ...sampled, blocking: pickBlocking(sampled.candidates) });
};
