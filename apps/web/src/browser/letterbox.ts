/**
 * A page's frames keep their aspect ratio inside whatever box shows them, so a view of any size
 * letterboxes the page instead of resizing it. These map points between the box a person sees
 * and the page's own viewport, for input going in and the agent's cursor coming out.
 *
 * @module letterbox
 */

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Where a frame of `frame` size sits when fitted whole (object-contain) into `box`. */
export function letterboxFit(box: Size, frame: Size) {
  const fit = Math.min(box.width / frame.width, box.height / frame.height);
  const width = frame.width * fit;
  const height = frame.height * fit;
  return { left: (box.width - width) / 2, top: (box.height - height) / 2, width, height };
}

/**
 * A point in the box, in CSS pixels from its top-left, as a point in the page's viewport.
 * `scale` is viewport pixels per box pixel, for wheel deltas. Null when nothing is painted.
 */
export function boxToViewport(point: Point, box: Size, frame: Size, viewport: Size) {
  const fitted = letterboxFit(box, frame);
  if (!(fitted.width > 0 && fitted.height > 0)) return null;
  return {
    x: ((point.x - fitted.left) * viewport.width) / fitted.width,
    y: ((point.y - fitted.top) * viewport.height) / fitted.height,
    scale: viewport.width / fitted.width,
  };
}

/** A point in the page's viewport as a point in the box, the inverse of boxToViewport. */
export function viewportToBox(point: Point, box: Size, frame: Size, viewport: Size): Point {
  const fitted = letterboxFit(box, frame);
  return {
    x: fitted.left + (point.x * fitted.width) / viewport.width,
    y: fitted.top + (point.y * fitted.height) / viewport.height,
  };
}
