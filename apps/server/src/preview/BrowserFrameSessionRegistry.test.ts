import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_MAX_IFRAME_DEPTH,
  DEFAULT_MAX_IFRAMES,
  MIN_CROSS_ORIGIN_IFRAME_EDGE,
  isCrossOriginIframeEligible,
  makeBrowserFrameSessionRegistry,
  resolveCrossOriginFrameTarget,
} from "./BrowserFrameSessionRegistry.ts";

const session = (sessionId: string, targetId: string) => ({ kind: "session", sessionId, targetId });
const none = (reason: string) => ({ kind: "none", reason });

const candidate = {
  width: MIN_CROSS_ORIGIN_IFRAME_EDGE,
  height: MIN_CROSS_ORIGIN_IFRAME_EDGE,
  visible: true,
  depth: DEFAULT_MAX_IFRAME_DEPTH,
  currentIframeCount: DEFAULT_MAX_IFRAMES - 1,
  visitedTargetIds: new Set<string>(),
  targetId: "target",
};

const frames = new Map([
  ["frame", { frameTargetId: "target", url: "https://example.com/path/?old=1", title: "Frame" }],
  ["local", { url: "https://example.com/local" }],
]);
const metadata = { targetId: "target", url: "https://target.test", title: "Target", type: "page" };
const targets = new Map([["target", metadata]]);

describe("frame session registry", () => {
  it("keeps one live session after duplicate attach", () => {
    const registry = makeBrowserFrameSessionRegistry();
    const attach = { sessionId: "s", targetId: "t", frameId: "f" };
    registry.onTargetAttached(attach);
    registry.onTargetAttached(attach);
    expect(registry.resolveSessionForNode({ frameId: "f" })).toEqual(session("s", "t"));
    registry.onTargetDetached({ sessionId: "s" });
    expect(registry.resolveSessionForNode({ targetId: "t" })).toEqual(none("target-detached"));
    expect(registry.resolveSessionForNode({ frameId: "f" })).toEqual(none("frame-unknown"));
  });

  it("retains a target and its frames until its last session detaches", () => {
    const registry = makeBrowserFrameSessionRegistry();
    registry.onTargetAttached({ sessionId: "s1", targetId: "t", frameId: "f" });
    registry.onTargetAttached({ sessionId: "s2", targetId: "t" });
    expect(registry.resolveSessionForNode({ frameId: "f" })).toEqual(session("s1", "t"));
    registry.onTargetDetached({ sessionId: "s1", targetId: "t" });
    expect(registry.resolveSessionForNode({ targetId: "t" })).toEqual(session("s2", "t"));
    expect(registry.resolveSessionForNode({ frameId: "f" })).toEqual(session("s2", "t"));
    registry.onTargetDetached({ sessionId: "s2", targetId: "t" });
    expect(registry.resolveSessionForNode({ frameId: "f" })).toEqual(none("frame-unknown"));
    expect(registry.resolveSessionForNode({ targetId: "t" })).toEqual(none("target-detached"));
  });

  it("registers an attach after an earlier detach and ignores duplicate detach", () => {
    const registry = makeBrowserFrameSessionRegistry();
    registry.onTargetDetached({ sessionId: "s", targetId: "t" });
    registry.onTargetAttached({ sessionId: "s", targetId: "t", frameId: "f" });
    expect(registry.resolveSessionForNode({ frameId: "f" })).toEqual(session("s", "t"));
    registry.onTargetDetached({ sessionId: "s" });
    registry.onTargetDetached({ sessionId: "s" });
    expect(registry.resolveSessionForNode({ sessionId: "s" })).toEqual(none("session-detached"));
    expect(registry.resolveSessionForNode({ frameId: "f" })).toEqual(none("frame-unknown"));
  });

  it("ignores detach events with a mismatched owner or an unknown session", () => {
    const registry = makeBrowserFrameSessionRegistry();
    registry.onTargetAttached({ sessionId: "s", targetId: "t", frameId: "f" });
    registry.onTargetDetached({ sessionId: "s", targetId: "other" });
    registry.onTargetDetached({ sessionId: "unknown", targetId: "t" });
    expect(registry.resolveSessionForNode({ sessionId: "s" })).toEqual(session("s", "t"));
    expect(registry.resolveSessionForNode({ frameId: "f" })).toEqual(session("s", "t"));
    expect(registry.resolveSessionForNode({ targetId: "t" })).toEqual(session("s", "t"));
  });

  it("moves a reattached session to its new target and ignores a stale detach", () => {
    const registry = makeBrowserFrameSessionRegistry();
    registry.onTargetAttached({ sessionId: "s", targetId: "a", frameId: "old" });
    registry.onTargetAttached({ sessionId: "s", targetId: "b", frameId: "new" });
    registry.onTargetDetached({ sessionId: "s", targetId: "a" });
    expect(registry.resolveSessionForNode({ targetId: "a" })).toEqual(none("target-detached"));
    expect(registry.resolveSessionForNode({ frameId: "old" })).toEqual(none("frame-unknown"));
    expect(registry.resolveSessionForNode({ frameId: "new" })).toEqual(session("s", "b"));
  });

  it("preserves a moved frame when its former target detaches", () => {
    const registry = makeBrowserFrameSessionRegistry();
    registry.onTargetAttached({ sessionId: "sa", targetId: "a", frameId: "f" });
    registry.onTargetAttached({ sessionId: "sb", targetId: "b" });
    registry.onFrameNavigated({ frameId: "f", targetId: "unknown" });
    expect(registry.resolveSessionForNode({ frameId: "f" })).toEqual(session("sa", "a"));
    registry.onFrameNavigated({ frameId: "f", targetId: "b" });
    registry.onFrameNavigated({ frameId: "f", targetId: "b" });
    expect(registry.resolveSessionForNode({ frameId: "f" })).toEqual(session("sb", "b"));
    registry.onTargetDetached({ sessionId: "sa", targetId: "a" });
    registry.onTargetDetached({ sessionId: "sa", targetId: "a" });
    expect(registry.resolveSessionForNode({ frameId: "f" })).toEqual(session("sb", "b"));
    expect(registry.resolveSessionForNode({ targetId: "b" })).toEqual(session("sb", "b"));
  });

  it("routes by the first present node reference and fails closed for stale references", () => {
    const registry = makeBrowserFrameSessionRegistry();
    registry.onTargetAttached({ sessionId: "sa", targetId: "a" });
    registry.onTargetAttached({ sessionId: "sb", targetId: "b", frameId: "f" });
    expect(
      registry.resolveSessionForNode({ sessionId: "sa", frameId: "f", targetId: "b" }),
    ).toEqual(session("sa", "a"));
    expect(
      registry.resolveSessionForNode({ sessionId: "stale", frameId: "f", targetId: "b" }),
    ).toEqual(none("session-detached"));
    expect(registry.resolveSessionForNode({ frameId: "unknown", targetId: "b" })).toEqual(
      none("frame-unknown"),
    );
    expect(registry.resolveSessionForNode({ frameId: "f", targetId: "a" })).toEqual(
      session("sb", "b"),
    );
    expect(registry.resolveSessionForNode({ targetId: "unknown" })).toEqual(
      none("target-detached"),
    );
    expect(registry.resolveSessionForNode({})).toEqual(none("missing-reference"));
    expect(registry.resolveSessionForNode({ sessionId: "", frameId: "", targetId: "" })).toEqual(
      none("missing-reference"),
    );
  });
});

describe("cross-origin iframe eligibility", () => {
  it("accepts the minimum size and the depth and count boundaries", () => {
    expect(isCrossOriginIframeEligible(candidate)).toEqual({ eligible: true });
    expect(
      isCrossOriginIframeEligible({ ...candidate, depth: DEFAULT_MAX_IFRAME_DEPTH + 1 }),
    ).toEqual({
      eligible: false,
      reason: "depth-limit",
    });
    expect(
      isCrossOriginIframeEligible({ ...candidate, currentIframeCount: DEFAULT_MAX_IFRAMES }),
    ).toEqual({
      eligible: false,
      reason: "count-limit",
    });
  });

  it("rejects undersized or non-finite dimensions", () => {
    for (const dimensions of [
      { width: MIN_CROSS_ORIGIN_IFRAME_EDGE - 0.01 },
      { height: MIN_CROSS_ORIGIN_IFRAME_EDGE - 0.01 },
    ]) {
      expect(isCrossOriginIframeEligible({ ...candidate, ...dimensions })).toEqual({
        eligible: false,
        reason: "too-small",
      });
    }
    for (const dimensions of [{ width: NaN }, { height: Infinity }]) {
      expect(isCrossOriginIframeEligible({ ...candidate, ...dimensions })).toEqual({
        eligible: false,
        reason: "invalid-size",
      });
    }
  });

  it("rejects invisible and already visited targets", () => {
    expect(isCrossOriginIframeEligible({ ...candidate, visible: false })).toEqual({
      eligible: false,
      reason: "invisible",
    });
    expect(
      isCrossOriginIframeEligible({ ...candidate, visitedTargetIds: new Set(["target"]) }),
    ).toEqual({
      eligible: false,
      reason: "visited",
    });
  });
});

describe("cross-origin frame target lookup", () => {
  it("uses frame ID and target metadata when both are known", () => {
    expect(
      resolveCrossOriginFrameTarget({ frameId: "frame", knownFrames: frames, targets }),
    ).toEqual({
      kind: "target",
      frameId: "frame",
      matchedBy: "frameId",
      target: metadata,
    });
  });

  it("does not substitute a URL match for a known frame without a target", () => {
    expect(
      resolveCrossOriginFrameTarget({
        frameId: "local",
        srcUrl: "https://example.com/path",
        knownFrames: frames,
        targets,
      }),
    ).toEqual(none("frame-has-no-target"));
  });

  it("matches an unknown frame ID by URL without query strings or trailing slashes", () => {
    expect(
      resolveCrossOriginFrameTarget({
        frameId: "unknown",
        srcUrl: "https://example.com/path///?new=2",
        knownFrames: frames,
        targets,
      }),
    ).toEqual({ kind: "target", frameId: "frame", matchedBy: "srcUrl", target: metadata });
  });

  it("returns frame-not-found when no frame or nonempty source matches", () => {
    expect(
      resolveCrossOriginFrameTarget({
        frameId: "unknown",
        srcUrl: "",
        knownFrames: frames,
        targets,
      }),
    ).toEqual(none("frame-not-found"));
    expect(
      resolveCrossOriginFrameTarget({
        srcUrl: "https://elsewhere.test",
        knownFrames: frames,
        targets,
      }),
    ).toEqual(none("frame-not-found"));
  });

  it("uses frame URL and title as iframe metadata when the target is absent", () => {
    expect(
      resolveCrossOriginFrameTarget({ frameId: "frame", knownFrames: frames, targets: new Map() }),
    ).toEqual({
      kind: "target",
      frameId: "frame",
      matchedBy: "frameId",
      target: {
        targetId: "target",
        url: "https://example.com/path/?old=1",
        title: "Frame",
        type: "iframe",
      },
    });
  });
});
