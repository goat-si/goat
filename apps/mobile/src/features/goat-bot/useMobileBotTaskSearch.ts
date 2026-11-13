import { runAtomCommand, squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import type { BotId, ChannelSearchBotTasksResult, EnvironmentId } from "@goat/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { appAtomRegistry } from "../../state/atom-registry";
import { channelEnvironment } from "../../state/channels";

/** Quiet time after the last keystroke before a query is sent. */
export const TASK_SEARCH_DEBOUNCE_MS = 300;
/** The server's bound, in UTF-8 bytes after trimming. */
const QUERY_MAX_BYTES = 256;
const utf8 = new TextEncoder();
const PAGE_SIZE = 20;
/** The most results one search holds; past it the walk offers no more. */
export const TASK_SEARCH_MAX_RESULTS = 50;

export type MobileTaskSearchState = {
  readonly tasks: ChannelSearchBotTasksResult["tasks"];
  readonly cursor?: string;
  readonly partial: boolean;
  readonly endedEarly: boolean;
  /** Held at the limit while the server had more, or stopped early. */
  readonly capped: boolean;
  readonly loading: boolean;
  readonly failed: boolean;
};
const EMPTY: MobileTaskSearchState = {
  tasks: [],
  partial: false,
  endedEarly: false,
  capped: false,
  loading: true,
  failed: false,
};

type Request = {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly botId: BotId;
  readonly query: string;
  /** Which of the field's queries this belongs to; a return to the same text is a new one. */
  readonly generation: number;
};

/** The text a person typed as the server takes it, or null when it would not be sent. */
export function taskSearchQuery(text: string): string | null {
  const query = text.trim();
  return query.length > 0 && !query.includes("\u0000") && !taskSearchTooLong(query) ? query : null;
}

/** Longer than the server reads; such a query is never sent. */
export function taskSearchTooLong(text: string) {
  return utf8.encode(text.trim()).length > QUERY_MAX_BYTES;
}

/**
 * One bot's task-title search (`channel.searchBotTasks`): sent after a quiet moment, one request
 * at a time, and only the field's latest query is answered. More results come only from the
 * server's cursor, on request, up to TASK_SEARCH_MAX_RESULTS. Unmounting ends it; a pending answer
 * then lands nowhere.
 */
export function useMobileBotTaskSearch(input: {
  readonly environmentId: EnvironmentId;
  readonly botId: BotId;
  readonly text: string;
}) {
  const { environmentId, botId } = input;
  const query = taskSearchQuery(input.text);
  const key = query === null ? null : JSON.stringify([environmentId, botId, query]);
  const [state, setState] = useState<{ key: string; value: MobileTaskSearchState } | null>(null);
  // Results belong to one visit of a query: leaving it drops them, so a return asks again.
  const [shownKey, setShownKey] = useState(key);
  if (shownKey !== key) {
    setShownKey(key);
    setState(null);
  }
  // The field's current query, the request in flight, and one waiting behind it.
  const generation = useRef(0);
  const busy = useRef(false);
  const queued = useRef<Request | null>(null);
  const alive = useRef(true);
  const send = async (request: Request, cursor?: string, held = 0, restarted = false) => {
    if (busy.current) {
      if (cursor === undefined) queued.current = request;
      return;
    }
    busy.current = true;
    const sentKey = request.key;
    setState((current) => ({
      key: sentKey,
      value:
        current?.key === sentKey && cursor !== undefined
          ? { ...current.value, loading: true, failed: false }
          : EMPTY,
    }));
    const limit = Math.min(PAGE_SIZE, TASK_SEARCH_MAX_RESULTS - held);
    const result = await runAtomCommand(
      appAtomRegistry,
      channelEnvironment.searchBotTasks,
      {
        environmentId: request.environmentId,
        input: {
          botId: request.botId,
          query: request.query,
          ...(cursor ? { cursor } : {}),
          limit,
        },
      },
      { label: "GOAT Bot task search", reportFailure: false },
    );
    busy.current = false;
    if (!alive.current) return;
    const next = queued.current;
    queued.current = null;
    if (request.generation !== generation.current) {
      if (next !== null && next.generation === generation.current) void send(next);
      return;
    }
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      const stale =
        cursor !== undefined &&
        typeof error === "object" &&
        error !== null &&
        "reason" in error &&
        error.reason === "invalid_input";
      // A continuation the server no longer accepts starts the walk again once.
      if (stale && !restarted) return void send(request, undefined, 0, true);
      setState((current) =>
        current?.key === sentKey
          ? { key: sentKey, value: { ...current.value, loading: false, failed: true } }
          : current,
      );
      return;
    }
    const page = result.value;
    setState((current) => {
      const before = current?.key === sentKey && cursor !== undefined ? current.value : null;
      const tasks = [...(before?.tasks ?? []), ...page.tasks].slice(0, TASK_SEARCH_MAX_RESULTS);
      const full = tasks.length >= TASK_SEARCH_MAX_RESULTS;
      const more = page.nextCursor !== undefined && !full;
      return {
        key: sentKey,
        value: {
          tasks,
          ...(more ? { cursor: page.nextCursor } : {}),
          partial: (before?.partial ?? false) || page.partial === true,
          endedEarly: page.endedEarly === true,
          capped: full && (page.nextCursor !== undefined || page.endedEarly === true),
          loading: false,
          failed: false,
        },
      };
    });
  };
  const fire = useEffectEvent((sent: Request) => void send(sent));
  // oxlint-disable-next-line goat/react-effect-budget -- Waits for a quiet moment before asking the server, and forgets a query the field moved past.
  useEffect(() => {
    alive.current = true;
    const current = ++generation.current;
    const timer =
      key === null || query === null
        ? undefined
        : setTimeout(
            () => fire({ key, environmentId, botId, query, generation: current }),
            TASK_SEARCH_DEBOUNCE_MS,
          );
    return () => {
      clearTimeout(timer);
      alive.current = false;
    };
  }, [key, environmentId, botId, query]);
  const value = key !== null && state?.key === key ? state.value : null;
  // A handler sends for the query the field shows now.
  const now = (): Request | null =>
    key === null || query === null
      ? null
      : { key, environmentId, botId, query, generation: generation.current };
  return {
    query,
    tooLong: taskSearchTooLong(input.text),
    value,
    loadMore: () => {
      const request = now();
      if (request !== null && value?.cursor && !value.loading)
        void send(request, value.cursor, value.tasks.length);
    },
    retry: () => {
      const request = now();
      if (request !== null && value?.failed)
        void send(request, value.cursor, value.cursor === undefined ? 0 : value.tasks.length);
    },
  };
}
