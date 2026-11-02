import type { ElementHandle, Locator, Page } from "playwright-core";
import {
  acquireTarget,
  actionCall,
  disposeAction,
  remaining,
  type ReadinessGate,
} from "./actionReadiness.ts";
import { ServerBrowserOperationError } from "./browserOperationError.ts";
import {
  classifyOcclusionHitTest,
  selectClickPoint,
  type FrameLink,
  type Point,
} from "./BrowserActuationGeometry.ts";
import { describeReceiver } from "./pointerReceiver.ts";
import { BrowserControlInterrupted } from "./SessionControl.ts";

/** Runs in the page: an element's client rects and boxes and, given a point, whether it is on top there. */
const probeElement = (node: unknown, at: readonly [number, number] | null) => {
  type PageNode = {
    readonly parentElement?: PageNode | null;
    readonly parentNode?: PageNode | null;
    readonly host?: PageNode | null;
    readonly shadowRoot?: { elementFromPoint(x: number, y: number): PageNode | null } | null;
    getRootNode(): { readonly host?: PageNode | null };
  };
  const element = node as PageNode & {
    readonly ownerDocument: { elementFromPoint(x: number, y: number): PageNode | null };
    readonly clientLeft: number;
    readonly clientTop: number;
    readonly clientWidth: number;
    readonly clientHeight: number;
    readonly offsetWidth: number;
    readonly offsetHeight: number;
    getBoundingClientRect(): { x: number; y: number; width: number; height: number };
    getClientRects(): ArrayLike<{ x: number; y: number; width: number; height: number }>;
  };
  const view = globalThis as unknown as {
    getComputedStyle(element: unknown): { getPropertyValue(name: string): string };
  };
  const rect = element.getBoundingClientRect();
  const style = view.getComputedStyle(element);
  const padding = (side: string) => Number.parseFloat(style.getPropertyValue(`padding-${side}`));
  const left = padding("left");
  const right = padding("right");
  const top = padding("top");
  const bottom = padding("bottom");
  let unproven =
    Math.abs(rect.width - element.offsetWidth) > 0.5 ||
    Math.abs(rect.height - element.offsetHeight) > 0.5;
  for (let current: PageNode | null | undefined = element; current;) {
    const currentStyle = view.getComputedStyle(current);
    for (const property of ["transform", "rotate", "scale", "translate", "zoom"]) {
      const value = currentStyle.getPropertyValue(property);
      if (value !== "" && value !== (property === "zoom" ? "1" : "none")) unproven = true;
    }
    current = current.parentElement ?? current.getRootNode().host;
  }
  let inside: boolean | undefined;
  if (at !== null) {
    let hit = element.ownerDocument.elementFromPoint(at[0], at[1]);
    while (hit?.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(at[0], at[1]);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    inside = false;
    for (
      let current: PageNode | null | undefined = hit;
      current;
      current = current.parentNode ?? current.host
    ) {
      if (current === element) {
        inside = true;
        break;
      }
    }
  }
  return {
    rects: Array.from(element.getClientRects(), ({ x, y, width, height }) => ({
      x,
      y,
      width,
      height,
    })),
    origin: { x: rect.x, y: rect.y },
    border: { x: element.clientLeft, y: element.clientTop },
    content: {
      x: rect.x + element.clientLeft + left,
      y: rect.y + element.clientTop + top,
      width: element.clientWidth - left - right,
      height: element.clientHeight - top - bottom,
    },
    unproven,
    inside,
  };
};

/**
 * Where a ref click lands: the centre of the target's most visible client rect, in top-level viewport
 * coordinates, and as Playwright's padding-box position. Refuses before any input when that spot is
 * not the target's in its own document or in any frame above it.
 */
export const aimClickPoint = async (
  page: Page,
  locator: Locator,
  deadline: number,
  gate: ReadinessGate,
): Promise<{ readonly point: Point; readonly position: Point }> => {
  const target = await acquireTarget(locator, remaining(deadline), gate.signal, gate);
  const elements: Array<ElementHandle> = [];
  try {
    for (
      let frame = await actionCall(gate, () => target.ownerFrame());
      frame?.parentFrame();
      frame = frame.parentFrame()
    ) {
      const child = frame;
      elements.unshift(await actionCall(gate, () => child.frameElement()));
    }
    const [measured, viewport] = await Promise.all([
      actionCall(gate, () => target.evaluate(probeElement, null)),
      // A browser GOAT attached to rather than launched has no emulated viewport.
      page.viewportSize() ??
        actionCall(gate, () =>
          page.mainFrame().evaluate(() => {
            const view = globalThis as unknown as { innerWidth: number; innerHeight: number };
            return { width: view.innerWidth, height: view.innerHeight };
          }),
        ),
    ]);
    const frames: Array<FrameLink> = [];
    for (const element of elements) {
      const probe = await actionCall(gate, () => element.evaluate(probeElement, null));
      frames.push({
        bounds: probe.content,
        scrollX: 0,
        scrollY: 0,
        ...(probe.unproven ? { unproven: true } : {}),
      });
    }
    const aimed = selectClickPoint({
      quads: measured.rects.map(({ x, y, width, height }) => [
        x,
        y,
        x + width,
        y,
        x + width,
        y + height,
        x,
        y + height,
      ]),
      viewport,
      frames,
    });
    const refusal = async (kind: string, message: string) => {
      const receiver =
        kind === "occluded_refused" ? await describeReceiver(page, locator, deadline) : undefined;
      return new ServerBrowserOperationError("PreviewAutomationExecutionError", message, {
        beforeInput: true,
        kind,
        ...(receiver === undefined ? {} : { interceptedBy: `Now at the target: ${receiver}.` }),
      });
    };
    if (!aimed.ok) {
      const messages = {
        no_visible_area:
          "The target has no visible spot inside the viewport, so nothing was clicked.",
        invalid_geometry: "The target's box could not be measured, so nothing was clicked.",
        oopif_transform_unproven:
          "The target sits in a transformed or zoomed frame whose mapping GOAT cannot prove, so nothing was clicked.",
      };
      throw await refusal(aimed.reason, messages[aimed.reason]);
    }
    const hitTest = async (element: ElementHandle, point: Point) => {
      let inside = false;
      let hitTestError: string | undefined;
      try {
        inside =
          (
            await actionCall(gate, () =>
              element.evaluate(probeElement, [point.x, point.y] as const),
            )
          ).inside === true;
      } catch (cause) {
        if (gate.signal?.aborted || cause instanceof BrowserControlInterrupted) throw cause;
        hitTestError = cause instanceof Error ? cause.message : String(cause);
      }
      // The in-page identity comparison has no CDP node id.
      const verdict = classifyOcclusionHitTest({
        backendNodeId: 0,
        hitMatchesTargetOrDescendant: inside,
        ...(hitTestError === undefined ? {} : { hitTestError }),
      });
      if (!verdict.ok) throw await refusal(verdict.detail.kind, verdict.message);
    };
    let offset: Point = { x: 0, y: 0 };
    for (const [index, element] of elements.entries()) {
      await hitTest(element, { x: aimed.point.x - offset.x, y: aimed.point.y - offset.y });
      const frame = frames[index];
      if (frame) offset = { x: offset.x + frame.bounds.x, y: offset.y + frame.bounds.y };
    }
    const local = { x: aimed.point.x - offset.x, y: aimed.point.y - offset.y };
    await hitTest(target, local);
    return {
      point: aimed.point,
      position: {
        x: local.x - measured.origin.x - measured.border.x,
        y: local.y - measured.origin.y - measured.border.y,
      },
    };
  } finally {
    for (const element of elements) disposeAction(gate, element);
    disposeAction(gate, target);
  }
};
