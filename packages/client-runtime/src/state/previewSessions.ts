import { type PreviewSession, type PreviewSessionStatus, WS_METHODS } from "@goat/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/** What agents drive on one environment's host, browser tabs and the desktop alike, and its controls. */
export function createPreviewSessionAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    sessions: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:preview-sessions",
      tag: WS_METHODS.previewSessionsSubscribe,
    }),
    control: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview-sessions:control",
      tag: WS_METHODS.previewSessionsControl,
    }),
  };
}

/** Live thumbnails never refresh faster than this, and not at all when nobody sees them (D11). */
export const PREVIEW_SESSION_THUMBNAIL_FRAME_MS = 500;
/** Thumbnails are scaled down on the server to at most this many device pixels wide. */
export const PREVIEW_SESSION_THUMBNAIL_WIDTH = 480;

const RANK: Readonly<Record<PreviewSessionStatus, number>> = {
  "waiting-for-human": 0,
  "permission-needed": 0,
  error: 0,
  acting: 1,
  observing: 1,
  paused: 1,
  idle: 2,
  stopped: 3,
};

/**
 * The order a stack shows sessions in: anything waiting for a person first, then live work, then
 * stopped ones. Ties keep the server's order, which lists the newest last, so newest goes first.
 */
export const orderPreviewSessions = (sessions: ReadonlyArray<PreviewSession>) =>
  sessions
    .map((session, index) => ({ session, index }))
    .sort((a, b) => RANK[a.session.status] - RANK[b.session.status] || b.index - a.index)
    .map(({ session }) => session);

/** The second line of a tile: the page's host, or what the desktop agent may touch. */
export const previewSessionDetail = (session: PreviewSession): string => {
  if (session.target.kind === "browser") {
    try {
      return new URL(session.target.url).host || session.target.url;
    } catch {
      return session.target.url;
    }
  }
  return session.lease?.scope === undefined ? "Whole screen" : session.target.title;
};
