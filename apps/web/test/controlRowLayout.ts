import { expect } from "vite-plus/test";

/** Sub-pixel slack: text and icons land on half pixels at fractional zoom. */
const TOLERANCE = 1;

const nameOf = (control: Element) =>
  control.getAttribute("aria-label") ?? control.textContent?.trim() ?? control.tagName;

/** The box around a control's visible marks: its icons and its text, not its padding. */
function inkBox(control: Element): { left: number; right: number; textCenters: number[] } {
  const rects: DOMRect[] = [];
  for (const mark of control.querySelectorAll("svg, img")) {
    const rect = mark.getBoundingClientRect();
    if (rect.width > 0) rects.push(rect);
  }
  const textCenters: number[] = [];
  const walker = document.createTreeWalker(control, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (!node.textContent?.trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    if (rect.width === 0) continue;
    rects.push(rect);
    textCenters.push(rect.top + rect.height / 2);
  }
  if (rects.length === 0) {
    const box = control.getBoundingClientRect();
    return { left: box.left, right: box.right, textCenters };
  }
  return {
    left: Math.min(...rects.map((rect) => rect.left)),
    right: Math.max(...rects.map((rect) => rect.right)),
    textCenters,
  };
}

export interface ControlRowOptions {
  /** Controls drawn as a filled shape, such as the round send button, are seen by their edge. */
  readonly filled?: ReadonlyArray<Element>;
  /** Every visible gap between neighbours matches, so no pair reads as closer or farther. */
  readonly evenGaps?: boolean;
}

/**
 * The rules a row of controls keeps: one height and one center line, no box overlapping its
 * neighbour, padding that is the same on both sides, text centered in its box, and, when asked,
 * the same visible gap between every pair of neighbours.
 */
export function expectAlignedControlRow(
  controls: ReadonlyArray<Element>,
  options: ControlRowOptions = {},
) {
  expect(controls.length, "a row needs at least two controls").toBeGreaterThan(1);
  const filled = new Set(options.filled ?? []);
  const boxes = controls.map((control) => control.getBoundingClientRect());
  const visible = controls.map((control, index) =>
    filled.has(control)
      ? { left: boxes[index]!.left, right: boxes[index]!.right, textCenters: [] }
      : inkBox(control),
  );
  const first = boxes[0]!;
  const center = (box: DOMRect) => box.top + box.height / 2;
  const gaps: number[] = [];

  controls.forEach((control, index) => {
    const box = boxes[index]!;
    const name = nameOf(control);
    expect(Math.abs(box.height - first.height), `${name} height`).toBeLessThanOrEqual(TOLERANCE);
    expect(Math.abs(center(box) - center(first)), `${name} center line`).toBeLessThanOrEqual(
      TOLERANCE,
    );
    const ink = visible[index]!;
    if (!filled.has(control)) {
      const start = ink.left - box.left;
      const end = box.right - ink.right;
      expect(Math.abs(start - end), `${name} padding ${start}/${end}`).toBeLessThanOrEqual(
        TOLERANCE,
      );
    }
    for (const textCenter of ink.textCenters) {
      expect(Math.abs(textCenter - center(box)), `${name} text center`).toBeLessThanOrEqual(
        TOLERANCE,
      );
    }
    if (index === 0) return;
    const previous = boxes[index - 1]!;
    expect(box.left, `${name} overlaps ${nameOf(controls[index - 1]!)}`).toBeGreaterThanOrEqual(
      previous.right - 0.5,
    );
    gaps.push(ink.left - visible[index - 1]!.right);
  });

  if (options.evenGaps) {
    for (const gap of gaps) {
      expect(Math.abs(gap - gaps[0]!), `visible gaps ${gaps.join(", ")}`).toBeLessThanOrEqual(
        TOLERANCE,
      );
    }
  }
}
