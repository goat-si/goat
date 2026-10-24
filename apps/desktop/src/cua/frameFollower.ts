import type { DesktopCuaFrame, DesktopCuaFrames, PreviewSessionNoPicture } from "@goat/contracts";

import type { HelperFrame, HelperSession } from "./ComputerUseHelper.ts";

type Frameable = Pick<HelperSession, "canFrame" | "frames" | "onFrame">;

/**
 * Keeps the helper's window captures in step with the server's cuaFrames request and passes
 * what it captures on as cuaFrame (#1370). The server decides which windows may be captured;
 * this only carries the request to whichever helper generation runs. A helper that cannot
 * capture, or a request that fails, is answered per window so the tile says why.
 */
export function makeFrameFollower(deps: {
  readonly publish: (frame: DesktopCuaFrame) => void;
  /** Runs a retry later, after a request failed while it still matters. */
  readonly retryLater: (retry: () => void) => void;
}) {
  let request: DesktopCuaFrames = { version: 1, type: "cuaFrames", seq: 0, targets: [] };
  let session: Frameable | undefined;
  /** The session and request seq the helper last accepted. */
  let sent: { readonly session: Frameable; readonly seq: number } | undefined;
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
    if (frame.framesId !== request.seq) return;
    deps.publish(
      frame.type === "frame"
        ? {
            version: 1,
            type: "cuaFrame",
            seq: frame.framesId,
            key: frame.key,
            width: frame.width,
            height: frame.height,
            mime: "image/jpeg",
            data: frame.data,
          }
        : {
            version: 1,
            type: "cuaFrameUnavailable",
            seq: frame.framesId,
            key: frame.key,
            reason: frame.reason,
          },
    );
  };
  const reconcile = async () => {
    const current = session;
    if (current === undefined) return;
    if (sent?.session === current && sent.seq === request.seq) return;
    // A helper starts capturing nothing; there is nothing to stop before the first request.
    if (sent?.session !== current && request.targets.length === 0) {
      sent = { session: current, seq: request.seq };
      return;
    }
    if (!current.canFrame) {
      // An older helper generation: it would answer an unknown method (#1338's lesson).
      sent = { session: current, seq: request.seq };
      refuse("unsupported");
      return;
    }
    const seq = request.seq;
    try {
      await current.frames(seq, request.targets);
      sent = { session: current, seq };
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
      if (next.seq < request.seq) return chain;
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
    },
  };
}
