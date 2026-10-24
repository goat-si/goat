import type { DesktopCuaFrame, DesktopCuaFrames, PreviewSessionNoPicture } from "@goat/contracts";

import type { HelperFrame, HelperSession } from "./ComputerUseHelper.ts";

type Frameable = Pick<HelperSession, "canFrame" | "frames" | "onFrame">;

/**
 * Keeps the helper's window captures in step with the server's cuaFrames request and passes
 * what it captures on as cuaFrame (#1370). The server decides which windows may be captured;
 * this only carries the request to whichever helper generation runs. A helper that cannot
 * capture, or a request that fails, is answered per window so the tile says why.
 *
 * Requests apply in the order the publisher hands them over. Their seq is the server's and starts
 * again when another server attaches, so it is never compared; the helper gets this follower's
 * own increasing framesId, and its frames go back under the seq of the request in force.
 *
 * A new request goes to the helper at once, never behind an earlier one's answer: the helper
 * reads requests in order, so a Stop written after a capture overrides it whenever either is
 * answered, and frames of the replaced request are dropped from the moment it is replaced.
 */
export function makeFrameFollower(deps: {
  readonly publish: (frame: DesktopCuaFrame) => void;
  /** Runs a retry later, after a request failed while it still matters. */
  readonly retryLater: (retry: () => void) => void;
}) {
  let request: DesktopCuaFrames = { version: 1, type: "cuaFrames", seq: 0, targets: [] };
  let session: Frameable | undefined;
  /** The session and request last written to the helper, answered or not. */
  let written: { readonly session: Frameable; readonly request: DesktopCuaFrames } | undefined;
  /**
   * The session that may be capturing: it was asked for a window, and no Stop it accepted
   * since. A request with no answer may still have started capturing.
   */
  let capturing: Frameable | undefined;
  /** The framesId of the request whose frames pass, and that request's server seq. */
  let inForce: { readonly framesId: number; readonly seq: number } | undefined;
  let lastFramesId = 0;
  let unsubscribe: (() => void) | undefined;
  let retryPending = false;

  const refuse = (reason: PreviewSessionNoPicture) => {
    for (const target of request.targets)
      deps.publish({
        version: 1,
        type: "cuaFrameUnavailable",
        seq: request.seq,
        key: target.key,
        reason,
      });
  };
  const onFrame = (frame: HelperFrame) => {
    if (inForce === undefined || frame.framesId !== inForce.framesId) return;
    const seq = inForce.seq;
    deps.publish(
      frame.type === "frame"
        ? {
            version: 1,
            type: "cuaFrame",
            seq,
            key: frame.key,
            width: frame.width,
            height: frame.height,
            mime: "image/jpeg",
            data: frame.data,
          }
        : { version: 1, type: "cuaFrameUnavailable", seq, key: frame.key, reason: frame.reason },
    );
  };
  const retry = () => {
    if (retryPending) return;
    retryPending = true;
    deps.retryLater(() => {
      retryPending = false;
      written = undefined;
      void reconcile();
    });
  };
  const reconcile = async (): Promise<void> => {
    const current = session;
    if (current === undefined) return;
    const wanted = request;
    if (written?.session === current && written.request === wanted) return;
    written = { session: current, request: wanted };
    // Nothing to stop on a helper that was never asked to capture.
    if (wanted.targets.length === 0 && capturing !== current) return;
    if (!current.canFrame) {
      // An older helper generation: it would answer an unknown method (#1338's lesson).
      refuse("unsupported");
      return;
    }
    const framesId = ++lastFramesId;
    inForce = wanted.targets.length === 0 ? undefined : { framesId, seq: wanted.seq };
    if (wanted.targets.length > 0) capturing = current;
    try {
      await current.frames(framesId, wanted.targets);
      if (wanted.targets.length === 0 && capturing === current && request === wanted)
        capturing = undefined;
    } catch {
      // Only the newest write matters: a later one, even a retry of this same request, was
      // written after it and the helper reads them in order.
      if (session !== current || framesId !== lastFramesId) return;
      refuse("captureFailed");
      retry();
    }
  };

  return {
    setRequest: (next: DesktopCuaFrames) => {
      request = next;
      // The replaced request's frames stop here, whatever the helper has answered.
      inForce = undefined;
      return reconcile();
    },
    /** The helper session of a generation that just started. */
    attach: (next: Frameable) => {
      if (session === next) return Promise.resolve();
      session = next;
      unsubscribe?.();
      unsubscribe = next.onFrame(onFrame);
      return reconcile();
    },
    /** The generation ended, and its captures with it. */
    detach: () => {
      unsubscribe?.();
      unsubscribe = undefined;
      session = undefined;
      written = undefined;
      capturing = undefined;
      inForce = undefined;
    },
  };
}
