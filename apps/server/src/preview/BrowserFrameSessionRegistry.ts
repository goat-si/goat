/**
 * Which CDP session owns each target and out-of-process iframe. Ported from browser-use's
 * SessionManager (browser/session_manager.py) and DomService iframe handling (dom/service.py).
 * Node routing fails closed where browser-use falls back to the focused page.
 */

export const MIN_CROSS_ORIGIN_IFRAME_EDGE = 10;
export const DEFAULT_MAX_IFRAMES = 100;
export const DEFAULT_MAX_IFRAME_DEPTH = 5;

export interface TargetAttached {
  readonly sessionId: string;
  readonly targetId: string;
  readonly frameId?: string | undefined;
}

export interface TargetDetached {
  readonly sessionId: string;
  /** Chrome may omit it; the session's recorded target is authoritative. */
  readonly targetId?: string | undefined;
}

export interface FrameNavigated {
  readonly frameId: string;
  readonly targetId: string;
}

export interface NodeSessionRef {
  readonly sessionId?: string | undefined;
  readonly frameId?: string | undefined;
  readonly targetId?: string | undefined;
}

export type NodeSessionResolution =
  | { readonly kind: "session"; readonly sessionId: string; readonly targetId: string }
  | {
      readonly kind: "none";
      readonly reason:
        | "missing-reference"
        | "session-detached"
        | "frame-unknown"
        | "target-detached";
    };

export interface BrowserFrameSessionRegistry {
  readonly onTargetAttached: (event: TargetAttached) => void;
  readonly onTargetDetached: (event: TargetDetached) => void;
  readonly onFrameNavigated: (event: FrameNavigated) => void;
  /** The first identifier present decides; a stale one never falls through to another session. */
  readonly resolveSessionForNode: (ref: NodeSessionRef) => NodeSessionResolution;
}

const present = (id: string | undefined): id is string => id !== undefined && id !== "";

const addTo = (index: Map<string, Set<string>>, key: string, value: string) => {
  const values = index.get(key);
  if (values === undefined) index.set(key, new Set([value]));
  else values.add(value);
};

export const makeBrowserFrameSessionRegistry = (): BrowserFrameSessionRegistry => {
  const sessionTarget = new Map<string, string>();
  const targetSessions = new Map<string, Set<string>>();
  const frameTarget = new Map<string, string>();
  const targetFrames = new Map<string, Set<string>>();

  const linkFrame = (frameId: string, targetId: string) => {
    const previous = frameTarget.get(frameId);
    if (previous === targetId) return;
    if (previous !== undefined) targetFrames.get(previous)?.delete(frameId);
    frameTarget.set(frameId, targetId);
    addTo(targetFrames, targetId, frameId);
  };

  // A target and its frames go away only with its last session, as in browser-use.
  const removeSession = (sessionId: string, targetId: string) => {
    sessionTarget.delete(sessionId);
    const sessions = targetSessions.get(targetId);
    if (sessions === undefined) return;
    sessions.delete(sessionId);
    if (sessions.size > 0) return;
    targetSessions.delete(targetId);
    for (const frameId of targetFrames.get(targetId) ?? []) frameTarget.delete(frameId);
    targetFrames.delete(targetId);
  };

  const firstSession = (targetId: string): string | undefined => {
    for (const sessionId of targetSessions.get(targetId) ?? []) return sessionId;
    return undefined;
  };

  const found = (sessionId: string, targetId: string): NodeSessionResolution => ({
    kind: "session",
    sessionId,
    targetId,
  });

  return {
    onTargetAttached: ({ sessionId, targetId, frameId }) => {
      const previous = sessionTarget.get(sessionId);
      if (previous !== undefined && previous !== targetId) removeSession(sessionId, previous);
      sessionTarget.set(sessionId, targetId);
      addTo(targetSessions, targetId, sessionId);
      if (present(frameId)) linkFrame(frameId, targetId);
    },
    onTargetDetached: ({ sessionId, targetId }) => {
      const owner = sessionTarget.get(sessionId);
      if (owner === undefined || (present(targetId) && targetId !== owner)) return;
      removeSession(sessionId, owner);
    },
    onFrameNavigated: ({ frameId, targetId }) => {
      if (targetSessions.has(targetId)) linkFrame(frameId, targetId);
    },
    resolveSessionForNode: ({ sessionId, frameId, targetId }) => {
      if (present(sessionId)) {
        const owner = sessionTarget.get(sessionId);
        return owner === undefined
          ? { kind: "none", reason: "session-detached" }
          : found(sessionId, owner);
      }
      if (present(frameId)) {
        const owner = frameTarget.get(frameId);
        const session = owner === undefined ? undefined : firstSession(owner);
        return owner === undefined || session === undefined
          ? { kind: "none", reason: "frame-unknown" }
          : found(session, owner);
      }
      if (present(targetId)) {
        const session = firstSession(targetId);
        return session === undefined
          ? { kind: "none", reason: "target-detached" }
          : found(session, targetId);
      }
      return { kind: "none", reason: "missing-reference" };
    },
  };
};

export interface IframeCandidate {
  readonly width: number;
  readonly height: number;
  readonly visible: boolean;
  /** The iframe's own nesting depth: an iframe in the top-level page has depth 1. */
  readonly depth: number;
  /** Cross-origin iframe targets already traversed, excluding the top-level target. */
  readonly currentIframeCount: number;
  readonly visitedTargetIds: ReadonlySet<string>;
  readonly targetId: string;
}

export type IframeEligibility =
  | { readonly eligible: true }
  | {
      readonly eligible: false;
      readonly reason:
        | "depth-limit"
        | "invisible"
        | "invalid-size"
        | "too-small"
        | "visited"
        | "count-limit";
    };

export const isCrossOriginIframeEligible = (candidate: IframeCandidate): IframeEligibility => {
  const skip = (reason: Extract<IframeEligibility, { eligible: false }>["reason"]) =>
    ({ eligible: false, reason }) as const;
  if (candidate.depth > DEFAULT_MAX_IFRAME_DEPTH) return skip("depth-limit");
  if (!candidate.visible) return skip("invisible");
  if (!Number.isFinite(candidate.width) || !Number.isFinite(candidate.height)) {
    return skip("invalid-size");
  }
  if (
    candidate.width < MIN_CROSS_ORIGIN_IFRAME_EDGE ||
    candidate.height < MIN_CROSS_ORIGIN_IFRAME_EDGE
  ) {
    return skip("too-small");
  }
  if (candidate.visitedTargetIds.has(candidate.targetId)) return skip("visited");
  if (candidate.currentIframeCount >= DEFAULT_MAX_IFRAMES) return skip("count-limit");
  return { eligible: true };
};

export interface KnownFrame {
  readonly url?: string | undefined;
  readonly title?: string | undefined;
  /** Set when the frame runs in its own target (an out-of-process iframe). */
  readonly frameTargetId?: string | undefined;
}

export interface KnownTarget {
  readonly targetId: string;
  readonly url: string;
  readonly title: string;
  readonly type: string;
}

export interface CrossOriginFrameLookup {
  readonly frameId?: string | undefined;
  readonly srcUrl?: string | undefined;
  readonly knownFrames: ReadonlyMap<string, KnownFrame>;
  readonly targets: ReadonlyMap<string, KnownTarget>;
}

export type FrameTargetResolution =
  | {
      readonly kind: "target";
      readonly frameId: string;
      readonly matchedBy: "frameId" | "srcUrl";
      readonly target: KnownTarget;
    }
  | { readonly kind: "none"; readonly reason: "frame-not-found" | "frame-has-no-target" };

const withoutQueryOrTrailingSlash = (url: string) => {
  const query = url.indexOf("?");
  return (query === -1 ? url : url.slice(0, query)).replace(/\/+$/, "");
};

// Chrome may not have registered an injected iframe's frameId in the frame tree yet, so an
// absent or unknown frameId falls back to matching the iframe's src against frame URLs.
const findFrame = ({ frameId, srcUrl, knownFrames }: CrossOriginFrameLookup) => {
  if (present(frameId)) {
    const frame = knownFrames.get(frameId);
    if (frame !== undefined) return { frameId, frame, matchedBy: "frameId" as const };
  }
  const src = withoutQueryOrTrailingSlash(srcUrl ?? "");
  if (src === "") return undefined;
  for (const [id, frame] of knownFrames) {
    if (withoutQueryOrTrailingSlash(frame.url ?? "") === src) {
      return { frameId: id, frame, matchedBy: "srcUrl" as const };
    }
  }
  return undefined;
};

export const resolveCrossOriginFrameTarget = (
  lookup: CrossOriginFrameLookup,
): FrameTargetResolution => {
  const match = findFrame(lookup);
  if (match === undefined) return { kind: "none", reason: "frame-not-found" };
  const targetId = match.frame.frameTargetId;
  if (!present(targetId)) return { kind: "none", reason: "frame-has-no-target" };
  const target = lookup.targets.get(targetId) ?? {
    targetId,
    url: match.frame.url ?? "",
    title: match.frame.title ?? "",
    type: "iframe",
  };
  return { kind: "target", frameId: match.frameId, matchedBy: match.matchedBy, target };
};
