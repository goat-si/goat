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
 */
export function makeFrameFollower(deps: {
  readonly publish: (frame: DesktopCuaFrame) => void;
  /** Runs a retry later, after a request failed while it still matters. */
  readonly retryLater: (retry: () => void) => void;
}) {
  let request: DesktopCuaFrames = { version: 1, type: "cuaFrames", seq: 0, targets: [] };
  let session: Frameable | undefined;
  /** The session and request the helper last accepted. */
  let sent: { readonly session: Frameable; readonly request: DesktopCuaFrames } | undefined;
  /** The framesId of the request the helper is asked for now, and that request's server seq. */
  let inForce: { readonly framesId: number; readonly seq: number } | undefined;
  let lastFramesId = 0;
  let unsubscribe: (() => void) | undefined;
  let retryPending = false;
  let chain = Promise.resolve();

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
        : {
            version: 1,
            type: "cuaFrameUnavailable",
            seq,
            key: frame.key,
            reason: frame.reason,
          },
    );
  };
  const reconcile = async () => {
    const current = session;
    if (current === undefined) return;
    const wanted = request;
    if (sent?.session === current && sent.request === wanted) return;
    // A helper starts capturing nothing; there is nothing to stop before the first request.
    if (sent?.session !== current && wanted.targets.length === 0) {
      sent = { session: current, request: wanted };
      return;
    }
    if (!current.canFrame) {
      // An older helper generation: it would answer an unknown method (#1338's lesson).
      sent = { session: current, request: wanted };
      refuse("unsupported");
      return;
    }
    const framesId = ++lastFramesId;
    // In force as it is sent, like the session's own filter: earlier frames drop from here on.
    inForce = { framesId, seq: wanted.seq };
    try {
      await current.frames(framesId, wanted.targets);
      sent = { session: current, request: wanted };
    } catch {
      refuse("captureFailed");
      if (!retryPending) {
        retryPending = true;
        deps.retryLater(() => {
          retryPending = false;
          void settle();
        });
      }
    }
  };
  // One change at a time, in order.
  const settle = () => {
    chain = chain.then(reconcile);
    return chain;
  };

  return {
    setRequest: (next: DesktopCuaFrames) => {
      request = next;
      return settle();
    },
    /** The helper session of a generation that just started. */
    attach: (next: Frameable) => {
      if (session === next) return chain;
      session = next;
      unsubscribe?.();
      unsubscribe = next.onFrame(onFrame);
      return settle();
    },
    /** The generation ended, and its captures with it. */
    detach: () => {
      unsubscribe?.();
      unsubscribe = undefined;
      session = undefined;
      sent = undefined;
      inForce = undefined;
    },
  };
}
