import type { PreviewAutomationClickRefusal } from "@goat/contracts";
import type { ElementHandle, Frame, Locator, Page } from "playwright-core";
import {
  acquireTarget,
  actionCall,
  disposeAction,
  remaining,
  revealFramesOf,
  type ReadinessGate,
} from "./actionReadiness.ts";
import { scrollIntoView } from "./actionScroll.ts";
import { ServerBrowserOperationError } from "./browserOperationError.ts";
import {
  classifyOcclusionHitTest,
  selectClickPoint,
  type FrameLink,
  type Point,
} from "./BrowserActuationGeometry.ts";
import { checkSpecialElementClickGuard } from "./BrowserDropdownAndDownloadPolicy.ts";
import { inViewport } from "./pointerInput.ts";
import { describeReceiver } from "./pointerReceiver.ts";
import { BrowserControlInterrupted } from "./SessionControl.ts";

const probeElement = (node: unknown, at: readonly [number, number] | null) => {
  type PageNode = {
    readonly tagName?: string;
    readonly type?: string;
    readonly control?: PageNode | null;
    readonly htmlFor?: string;
    readonly labels?: ArrayLike<PageNode> | null;
    readonly parentElement?: PageNode | null;
    readonly parentNode?: PageNode | null;
    readonly assignedSlot?: PageNode | null;
    readonly host?: PageNode | null;
    readonly shadowRoot?: { elementFromPoint(x: number, y: number): PageNode | null } | null;
    getRootNode(): {
      readonly host?: PageNode | null;
      getElementById?(id: string): PageNode | null;
    };
  };
  const element = node as PageNode & {
    readonly ownerDocument: {
      elementFromPoint(x: number, y: number): PageNode | null;
      getElementById?(id: string): PageNode | null;
    };
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
  const within = (
    candidate: PageNode | null | undefined,
    ancestor: PageNode | null | undefined,
  ) => {
    if (!candidate || !ancestor) return false;
    for (
      let current: PageNode | null | undefined = candidate;
      current;
      current = current.assignedSlot ?? current.parentNode ?? current.host
    ) {
      if (current === ancestor) return true;
    }
    return false;
  };
  const enclosingLabel = (candidate: PageNode | null | undefined) => {
    for (
      let current: PageNode | null | undefined = candidate;
      current;
      current = current.parentElement
    ) {
      if (current.tagName?.toUpperCase() === "LABEL") return current;
    }
    return null;
  };
  const labelControl = (label: PageNode | null): PageNode | null => {
    if (!label) return null;
    if (label.control) return label.control;
    if (label.control === undefined && label.htmlFor) {
      const root = label.getRootNode();
      return (
        root.getElementById?.(label.htmlFor) ??
        element.ownerDocument.getElementById?.(label.htmlFor) ??
        null
      );
    }
    return null;
  };
  const hasLabel = (candidate: PageNode | null | undefined, label: PageNode | null) => {
    if (!candidate || !label || !candidate.labels) return false;
    for (let index = 0; index < candidate.labels.length; index++) {
      if (candidate.labels[index] === label) return true;
    }
    return false;
  };
  const targetLabel = enclosingLabel(element);
  const targetControl = labelControl(targetLabel);
  let inside: boolean | undefined;
  let associated: boolean | undefined;
  if (at !== null) {
    let hit = element.ownerDocument.elementFromPoint(at[0], at[1]);
    while (hit?.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(at[0], at[1]);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    inside = within(hit, element);
    const hitLabel = enclosingLabel(hit);
    const hitControl = labelControl(hitLabel);
    associated =
      (hitLabel !== null &&
        (hitControl === element ||
          within(element, hitControl) ||
          hasLabel(element, hitLabel) ||
          (hitControl === null && within(element, hitLabel)))) ||
      (targetLabel !== null &&
        (targetControl === hit ||
          within(hit, targetControl) ||
          hasLabel(hit, targetLabel) ||
          (targetControl === null && within(hit, targetLabel)))) ||
      (hitControl !== null && targetControl !== null && hitControl === targetControl);
  }
  return {
    tagName: typeof element.tagName === "string" ? element.tagName : "",
    inputType: typeof element.type === "string" ? element.type : undefined,
    labelControlTagName: typeof targetControl?.tagName === "string" ? targetControl.tagName : "",
    labelControlInputType: typeof targetControl?.type === "string" ? targetControl.type : undefined,
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
    associated,
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
): Promise<{
  readonly point: Point;
  readonly position: Point;
  readonly associatedLabel?: boolean;
}> => {
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
    const refusal = async (kind: PreviewAutomationClickRefusal, message: string) => {
      const receiver =
        kind === "occluded_refused" ? await describeReceiver(page, locator, deadline) : undefined;
      return new ServerBrowserOperationError("PreviewAutomationExecutionError", message, {
        beforeInput: true,
        clickRefusal: kind,
        kind,
        ...(receiver === undefined ? {} : { interceptedBy: `Now at the target: ${receiver}.` }),
      });
    };
    const specialGuard = checkSpecialElementClickGuard({
      tagName: typeof measured.tagName === "string" ? measured.tagName : "",
      inputType: typeof measured.inputType === "string" ? measured.inputType : undefined,
    });
    if (!specialGuard.ok) throw await refusal("special_element_refused", specialGuard.message);
    if (typeof measured.labelControlTagName === "string" && measured.labelControlTagName !== "") {
      const labelGuard = checkSpecialElementClickGuard({
        tagName: measured.labelControlTagName,
        inputType:
          typeof measured.labelControlInputType === "string"
            ? measured.labelControlInputType
            : undefined,
      });
      if (!labelGuard.ok) throw await refusal("special_element_refused", labelGuard.message);
    }
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
      let associated = false;
      let hitTestError: string | undefined;
      try {
        const probed = await actionCall(gate, () =>
          element.evaluate(probeElement, [point.x, point.y] as const),
        );
        inside = probed.inside === true;
        associated = probed.associated === true;
      } catch (cause) {
        if (gate.signal?.aborted || cause instanceof BrowserControlInterrupted) throw cause;
        hitTestError = cause instanceof Error ? cause.message : String(cause);
      }
      const verdict = classifyOcclusionHitTest({
        backendNodeId: 0,
        hitMatchesTargetOrDescendant: inside,
        hitIsAssociatedLabelOrControl: associated,
        ...(hitTestError === undefined ? {} : { hitTestError }),
      });
      if (!verdict.ok) throw await refusal(verdict.detail.kind, verdict.message);
      return { inside, associated };
    };
    let offset: Point = { x: 0, y: 0 };
    for (const [index, element] of elements.entries()) {
      await hitTest(element, { x: aimed.point.x - offset.x, y: aimed.point.y - offset.y });
      const frame = frames[index];
      if (frame) offset = { x: offset.x + frame.bounds.x, y: offset.y + frame.bounds.y };
    }
    const local = { x: aimed.point.x - offset.x, y: aimed.point.y - offset.y };
    const targetHit = await hitTest(target, local);
    return {
      point: aimed.point,
      position: {
        x: local.x - measured.origin.x - measured.border.x,
        y: local.y - measured.origin.y - measured.border.y,
      },
      ...(targetHit.associated && !targetHit.inside ? { associatedLabel: true } : {}),
    };
  } finally {
    for (const element of elements) disposeAction(gate, element);
    disposeAction(gate, target);
  }
};

export const locatePoint = async (
  page: Page,
  locator: Locator | null,
  input: { readonly x?: number | undefined; readonly y?: number | undefined },
  deadline: number,
  gate: ReadinessGate,
) => {
  if (locator === null) return { x: input.x ?? 0, y: input.y ?? 0 };
  const target = await acquireTarget(locator, remaining(deadline), gate.signal, gate);
  try {
    await revealFramesOf(target, deadline, gate);
  } finally {
    disposeAction(gate, target);
  }
  const viewport = page.viewportSize();
  let box = await actionCall(gate, () => locator.boundingBox({ timeout: remaining(deadline) }));
  if (!inViewport(box, viewport)) {
    await scrollIntoView(locator, deadline, gate);
    box = await actionCall(gate, () => locator.boundingBox({ timeout: remaining(deadline) }));
  }
  if (box) return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  return { x: (viewport?.width ?? 0) / 2, y: (viewport?.height ?? 0) / 2 };
};

const probePointElement = (at: readonly [number, number]) => {
  type PageNode = {
    readonly tagName?: string;
    readonly type?: string;
    readonly control?: PageNode | null;
    readonly htmlFor?: string;
    readonly parentElement?: PageNode | null;
    readonly shadowRoot?: { elementFromPoint(x: number, y: number): PageNode | null } | null;
    getRootNode?(): { getElementById?(id: string): PageNode | null };
  };
  const doc = (
    globalThis as unknown as {
      readonly document?: {
        elementFromPoint(x: number, y: number): PageNode | null;
        getElementById?(id: string): PageNode | null;
      };
    }
  ).document;
  let hit = doc?.elementFromPoint(at[0], at[1]) ?? null;
  while (hit?.shadowRoot) {
    const inner = hit.shadowRoot.elementFromPoint(at[0], at[1]);
    if (!inner || inner === hit) break;
    hit = inner;
  }
  if (!hit) return null;
  let label: PageNode | null = null;
  for (let current: PageNode | null | undefined = hit; current; current = current.parentElement) {
    if (current.tagName?.toUpperCase() === "LABEL") {
      label = current;
      break;
    }
  }
  let control: PageNode | null = null;
  if (label) {
    if (label.control) control = label.control;
    else if (label.control === undefined && label.htmlFor)
      control =
        label.getRootNode?.().getElementById?.(label.htmlFor) ??
        doc?.getElementById?.(label.htmlFor) ??
        null;
  }
  return {
    tagName: typeof hit.tagName === "string" ? hit.tagName : "",
    inputType: typeof hit.type === "string" ? hit.type : undefined,
    labelControlTagName: typeof control?.tagName === "string" ? control.tagName : "",
    labelControlInputType: typeof control?.type === "string" ? control.type : undefined,
  };
};

export const assertCoordinateClickAllowed = async (
  frame: Frame,
  point: Point,
  gate: ReadinessGate,
): Promise<void> => {
  let probed: {
    readonly tagName?: unknown;
    readonly inputType?: unknown;
    readonly labelControlTagName?: unknown;
    readonly labelControlInputType?: unknown;
  } | null = null;
  try {
    probed = await actionCall(gate, () =>
      frame.evaluate(probePointElement, [point.x, point.y] as const),
    );
  } catch (cause) {
    if (gate.signal?.aborted || cause instanceof BrowserControlInterrupted) throw cause;
    throw new ServerBrowserOperationError(
      "PreviewAutomationExecutionError",
      "Could not verify the click target at those coordinates, so nothing was clicked.",
      {
        beforeInput: true,
        clickRefusal: "invalid_geometry",
        kind: "invalid_geometry",
      },
    );
  }
  if (probed === null || typeof probed !== "object") {
    throw new ServerBrowserOperationError(
      "PreviewAutomationExecutionError",
      "No element was found at those coordinates, so nothing was clicked.",
      {
        beforeInput: true,
        clickRefusal: "invalid_geometry",
        kind: "invalid_geometry",
      },
    );
  }
  const guard = checkSpecialElementClickGuard({
    tagName: typeof probed.tagName === "string" ? probed.tagName : "",
    inputType: typeof probed.inputType === "string" ? probed.inputType : undefined,
  });
  if (!guard.ok) {
    throw new ServerBrowserOperationError("PreviewAutomationExecutionError", guard.message, {
      beforeInput: true,
      clickRefusal: "special_element_refused",
      kind: "special_element_refused",
    });
  }
  if (typeof probed.labelControlTagName === "string" && probed.labelControlTagName !== "") {
    const labelGuard = checkSpecialElementClickGuard({
      tagName: probed.labelControlTagName,
      inputType:
        typeof probed.labelControlInputType === "string" ? probed.labelControlInputType : undefined,
    });
    if (!labelGuard.ok) {
      throw new ServerBrowserOperationError("PreviewAutomationExecutionError", labelGuard.message, {
        beforeInput: true,
        clickRefusal: "special_element_refused",
        kind: "special_element_refused",
      });
    }
  }
};
