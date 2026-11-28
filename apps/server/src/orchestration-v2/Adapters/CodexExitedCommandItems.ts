import type * as CodexAppServer from "effect-codex-app-server/client";
import * as Effect from "effect/Effect";

import {
  decodeCodexBackgroundTerminalTerminateResponse,
  decodeCodexBackgroundTerminalsListResponse,
  type CodexBackgroundTerminalsListPage,
} from "./CodexBackgroundTerminalSchemas.ts";
import { toProtocolError } from "./CodexProtocolError.ts";

export interface TrackedProcessCommandItem {
  readonly id: string;
  readonly processId?: string;
}

export const terminateCodexBackgroundTerminal = Effect.fn(
  "CodexAdapterV2.terminateBackgroundTerminal",
)(function* (
  client: CodexAppServer.CodexAppServerClient["Service"],
  nativeThreadId: string,
  processId: string,
) {
  const response = yield* client.raw
    .request("thread/backgroundTerminals/terminate", {
      threadId: nativeThreadId,
      processId,
    })
    .pipe(
      Effect.catchTags({
        CodexAppServerProcessExitedError: () => Effect.succeed({ terminated: true }),
        CodexAppServerInputStreamEndedError: () => Effect.succeed({ terminated: true }),
        // Unloading kills terminals, so "thread not found" means nothing remains to stop.
        CodexAppServerRequestError: (error) =>
          error.code === -32600 && error.errorMessage.startsWith("thread not found:")
            ? Effect.succeed({ terminated: true })
            : Effect.fail(error),
      }),
    );
  const result = yield* decodeCodexBackgroundTerminalTerminateResponse(response);
  if (result.terminated) return;
  let cursor: string | null = null;
  while (true) {
    const listResponse: unknown = yield* client.raw.request("thread/backgroundTerminals/list", {
      threadId: nativeThreadId,
      ...(cursor === null ? {} : { cursor }),
    });
    const page: CodexBackgroundTerminalsListPage =
      yield* decodeCodexBackgroundTerminalsListResponse(listResponse);
    if (page.data.some((terminal) => terminal.processId === processId)) {
      return yield* toProtocolError(
        `Codex background terminal ${processId} remained active after termination.`,
      );
    }
    if (page.nextCursor === null) return;
    cursor = page.nextCursor;
  }
}, Effect.timeout("10 seconds"));

export const listCodexBackgroundTerminalProcessIds = Effect.fn(
  "CodexAdapterV2.listBackgroundTerminalProcessIds",
)(function* <E>(
  request: (method: string, params: Record<string, unknown>) => Effect.Effect<unknown, E>,
  nativeThreadId: string,
) {
  const liveProcessIds = new Set<string>();
  let cursor: string | null = null;
  while (true) {
    const response: unknown = yield* request("thread/backgroundTerminals/list", {
      threadId: nativeThreadId,
      ...(cursor === null ? {} : { cursor }),
    });
    const page: CodexBackgroundTerminalsListPage =
      yield* decodeCodexBackgroundTerminalsListResponse(response);
    for (const terminal of page.data) liveProcessIds.add(terminal.processId);
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return liveProcessIds;
});

export function selectExitedCodexCommandItemIds(
  runningByTurn: ReadonlyMap<string, ReadonlyMap<string, TrackedProcessCommandItem>>,
  turnItems: ReadonlyMap<string, TrackedProcessCommandItem>,
  liveProcessIds: ReadonlySet<string>,
): ReadonlySet<string> {
  // A command whose process id Codex never sent may own any terminal no tracked command claims.
  const claimed = new Set<string>();
  for (const tracked of runningByTurn.values()) {
    for (const item of tracked.values()) {
      if (item.processId !== undefined) claimed.add(item.processId);
    }
  }
  const unclaimedLive = [...liveProcessIds].some((id) => !claimed.has(id));
  const exited = new Set<string>();
  for (const item of turnItems.values()) {
    if (item.processId === undefined ? !unclaimedLive : !liveProcessIds.has(item.processId)) {
      exited.add(item.id);
    }
  }
  return exited;
}

export function addUnknownOutcomeCommandItems(
  current: ReadonlyMap<string, Set<string>>,
  nativeTurnId: string,
  exited: ReadonlySet<string>,
): Map<string, Set<string>> {
  return new Map(current).set(
    nativeTurnId,
    new Set([...(current.get(nativeTurnId) ?? []), ...exited]),
  );
}

export function takeUnknownOutcomeCommandItem(
  current: Map<string, Set<string>>,
  nativeTurnId: string,
  itemId: string,
): readonly [boolean, Map<string, Set<string>>] {
  const items = current.get(nativeTurnId);
  if (items === undefined || !items.has(itemId)) {
    return [false, current] as const;
  }
  const remaining = new Set(items);
  remaining.delete(itemId);
  const updated = new Map(current);
  if (remaining.size === 0) updated.delete(nativeTurnId);
  else updated.set(nativeTurnId, remaining);
  return [true, updated] as const;
}
