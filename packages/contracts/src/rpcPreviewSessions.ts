import * as Schema from "effect/Schema";
import { Rpc } from "effect/rpc";
import { EnvironmentAuthorizationError } from "./auth.ts";
import { HandoffError } from "./handoff.ts";
import {
  PreviewSessionControlInput,
  PreviewSessionControlResult,
  PreviewSessionFrameEvent,
  PreviewSessionFramesInput,
  PreviewSessionsSnapshot,
} from "./previewSession.ts";

export const PREVIEW_SESSION_METHODS = {
  previewSessionsSubscribe: "previewSessions.subscribe",
  previewSessionsControl: "previewSessions.control",
  previewSessionsFrames: "previewSessions.frames",
} as const;

/** Every browser and desktop preview session on this host, again whenever one changes. */
export const WsPreviewSessionsSubscribeRpc = Rpc.make(
  PREVIEW_SESSION_METHODS.previewSessionsSubscribe,
  {
    payload: Schema.Struct({}),
    success: PreviewSessionsSnapshot,
    error: EnvironmentAuthorizationError,
    stream: true,
  },
);

/** A person's takeover, hand back, stop or kill switch on a preview session. */
export const WsPreviewSessionsControlRpc = Rpc.make(
  PREVIEW_SESSION_METHODS.previewSessionsControl,
  {
    payload: PreviewSessionControlInput,
    success: PreviewSessionControlResult,
    error: Schema.Union([EnvironmentAuthorizationError, HandoffError]),
  },
);

export const WsPreviewSessionsFramesRpc = Rpc.make(PREVIEW_SESSION_METHODS.previewSessionsFrames, {
  payload: PreviewSessionFramesInput,
  success: PreviewSessionFrameEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});
