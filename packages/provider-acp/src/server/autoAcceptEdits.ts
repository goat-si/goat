import {
  appendToolContentText,
  setToolOutputText,
  appendToolOutputText,
  textFromUnknown,
} from "./toolOutputText.ts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import type * as EffectAcpSchema from "effect-acp/compat";
import type { AcpToolCallState } from "./runtimeModel.ts";
import { acpChangedPathsOfToolCall, mergeAcpChangedPaths, unknownRecord } from "./clientPolicy.ts";

/** A location entry no path can be read from, so the changed paths of a request carrying it are unknown. */
const UNREADABLE_LOCATION: EffectAcpSchema.ToolCallLocation = { path: "" };

/**
 * The request with the changed paths of its tracked tool call added to its locations, so policy
 * reads one request and sees every path either of them named. `tracked` must be the call of the
 * session that sent the request. Paths the tracked call could not fully name stay unknown here.
 */
export function withTrackedChangedPaths(
  params: EffectAcpSchema.RequestPermissionRequest,
  tracked: AcpToolCallState | undefined,
): EffectAcpSchema.RequestPermissionRequest {
  const seen = tracked?.changedPaths;
  if (seen === undefined || (seen !== "unknown" && seen.length === 0)) return params;
  const own: unknown = params.toolCall.locations;
  const locations =
    seen === "unknown" || (own !== undefined && own !== null && !Array.isArray(own))
      ? [UNREADABLE_LOCATION]
      : [...(params.toolCall.locations ?? []), ...seen.map((path) => ({ path }))];
  return { ...params, toolCall: { ...params.toolCall, locations } };
}

const TOOL_CALL_SESSION_UPDATES: ReadonlySet<unknown> = new Set([
  "tool_call",
  "tool_call_update",
  "tool_call_content_chunk",
]);

/**
 * What can still be read of a dropped notification that may have described a tool call: the
 * session and tool call it named, each absent when it is not a non-empty string. Undefined for
 * a notification of another method or of a kind that is not a tool call; a kind that cannot be
 * read counts, because it may have been one.
 */
export function unreadToolCallUpdate(
  method: string,
  payload: unknown,
): { readonly sessionId?: string; readonly toolCallId?: string } | undefined {
  if (method !== "session/update") return undefined;
  const update = unknownRecord(payload) ? unknownRecord(payload)?.update : undefined;
  const kind = unknownRecord(update) ? unknownRecord(update)?.sessionUpdate : undefined;
  if (typeof kind === "string" && !TOOL_CALL_SESSION_UPDATES.has(kind)) return undefined;
  const sessionId = unknownRecord(payload) ? unknownRecord(payload)?.sessionId : undefined;
  const toolCallId = unknownRecord(update) ? unknownRecord(update)?.toolCallId : undefined;
  return {
    ...(typeof sessionId === "string" && sessionId.length > 0 ? { sessionId } : {}),
    ...(typeof toolCallId === "string" && toolCallId.length > 0 ? { toolCallId } : {}),
  };
}

/** Past this many tool calls with an unread notification, every tool call counts as one. */
export const MAX_UNREAD_TOOL_CALLS = 4096;

/**
 * The tool calls of one provider session that had a notification dropped before it was read,
 * so the paths they changed are not all known. Entries are never removed.
 */
export interface AcpUnreadToolCalls {
  /** Records the tool calls a dropped notification may have described. */
  readonly add: (
    unread: { readonly sessionId?: string; readonly toolCallId?: string },
    /** The tool calls tracked for that session, used when the notification names none. */
    trackedToolCallIds: Iterable<string>,
  ) => void;
  readonly has: (sessionId: string, toolCallId: string) => boolean;
}

export function makeAcpUnreadToolCalls(): AcpUnreadToolCalls {
  // A notification whose session cannot be read is recorded for every session.
  const ANY_SESSION = Symbol("any session");
  const bySession = new Map<string | typeof ANY_SESSION, Set<string>>();
  let size = 0;
  return {
    add: (unread, trackedToolCallIds) => {
      const session = unread.sessionId ?? ANY_SESSION;
      const ids = bySession.get(session) ?? new Set<string>();
      bySession.set(session, ids);
      for (const id of unread.toolCallId === undefined ? trackedToolCallIds : [unread.toolCallId]) {
        if (ids.has(id)) continue;
        if (size < MAX_UNREAD_TOOL_CALLS) ids.add(id);
        size += 1;
      }
    },
    has: (sessionId, toolCallId) =>
      size > MAX_UNREAD_TOOL_CALLS ||
      bySession.get(sessionId)?.has(toolCallId) === true ||
      bySession.get(ANY_SESSION)?.has(toolCallId) === true,
  };
}

/** The tracked tool call as policy should read it when one of its notifications was dropped. */
export function withUnknownChangedPaths(
  tracked: AcpToolCallState | undefined,
  toolCallId: string,
): AcpToolCallState {
  return { ...(tracked ?? { toolCallId, data: {} }), changedPaths: "unknown" };
}

export function autoAcceptPolicyRequest(
  params: EffectAcpSchema.RequestPermissionRequest,
  knownTool: AcpToolCallState | undefined,
  unread: AcpUnreadToolCalls,
): EffectAcpSchema.RequestPermissionRequest {
  return withTrackedChangedPaths(
    params.toolCall.kind == null && knownTool?.kind !== undefined
      ? { ...params, toolCall: { ...params.toolCall, kind: knownTool.kind } }
      : params,
    unread.has(params.sessionId, params.toolCall.toolCallId)
      ? withUnknownChangedPaths(knownTool, params.toolCall.toolCallId)
      : knownTool,
  );
}

export function makeUndecodableNotificationHandler<
  T extends { readonly tools: Map<string, AcpToolCallState> },
>(
  unreadToolCalls: AcpUnreadToolCalls,
  activeSessionId: Ref.Ref<string | null>,
  activeTurn: Ref.Ref<T | null>,
) {
  return Effect.fn("AcpAdapterV2.noteUndecodableNotification")(function* (
    method: string,
    payload: unknown,
  ) {
    const unread = unreadToolCallUpdate(method, payload);
    if (unread === undefined) return;
    const fromRootSession =
      unread.sessionId === undefined || unread.sessionId === (yield* Ref.get(activeSessionId));
    unreadToolCalls.add(
      unread,
      fromRootSession ? ((yield* Ref.get(activeTurn))?.tools.keys() ?? []) : [],
    );
  });
}

export function trackChunkPaths(stored: AcpToolCallState, content: unknown): AcpToolCallState {
  const paths = acpChangedPathsOfToolCall({ content: [content] });
  return paths === "unknown" || paths.length > 0
    ? { ...stored, changedPaths: mergeAcpChangedPaths(stored.changedPaths, paths) }
    : stored;
}

export function chunkNamesPaths(content: unknown): boolean {
  const paths = acpChangedPathsOfToolCall({ content: [content] });
  return paths === "unknown" || paths.length > 0;
}

export function chunkOutput(
  previous: AcpToolCallState,
  isContent: boolean,
  text: string | undefined,
): AcpToolCallState {
  if (text === undefined) return previous;
  if (isContent && previous.data.rawOutput === undefined)
    return {
      ...previous,
      data: { ...previous.data, content: appendToolContentText(previous.data.content, text) },
    };
  return previous.data.rawOutput === undefined
    ? setToolOutputText(previous, `${textFromUnknown(previous.data.content) ?? ""}${text}`)
    : appendToolOutputText(previous, text);
}
