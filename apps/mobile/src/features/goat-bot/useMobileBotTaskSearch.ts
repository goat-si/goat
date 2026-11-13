import { runAtomCommand, squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import type { BotId, ChannelSearchBotTasksResult, EnvironmentId } from "@goat/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { appAtomRegistry } from "../../state/atom-registry";
import { channelEnvironment } from "../../state/channels";

/** Quiet time after the last keystroke before a query is sent. */
export const TASK_SEARCH_DEBOUNCE_MS = 300;
const QUERY_MAX = 256;

export type MobileTaskSearchState = {
  readonly tasks: ChannelSearchBotTasksResult["tasks"];
  readonly cursor?: string;
  readonly partial: boolean;
  readonly endedEarly: boolean;
  readonly loading: boolean;
  readonly failed: boolean;
};
const EMPTY: MobileTaskSearchState = {
  tasks: [],
  partial: false,
  endedEarly: false,
  loading: true,
  failed: false,
};

type Request = {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly botId: BotId;
  readonly query: string;
};

/** The text a person typed as the server takes it, or null when it would not be sent. */
export function taskSearchQuery(text: string): string | null {
  const query = text.trim();
  return query.length > 0 && query.length <= QUERY_MAX && !query.includes("\u0000") ? query : null;
}

/**
 * One bot's task-title search (`channel.searchBotTasks`): sent after a quiet moment, one request
 * at a time, and only the latest query's answer is kept. More results come only from the server's
 * cursor, on request. Unmounting ends it; a pending answer then lands nowhere.
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
  // The query the field wants answered, the request in flight, and one waiting behind it.
  const wanted = useRef<string | null>(null);
  const busy = useRef(false);
  const queued = useRef<Request | null>(null);
  const alive = useRef(true);
  const send = async (request: Request, cursor?: string, restarted = false) => {
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
    const result = await runAtomCommand(
      appAtomRegistry,
      channelEnvironment.searchBotTasks,
      {
        environmentId: request.environmentId,
        input: { botId: request.botId, query: request.query, ...(cursor ? { cursor } : {}) },
      },
      { label: "GOAT Bot task search", reportFailure: false },
    );
    busy.current = false;
    if (!alive.current) return;
    const next = queued.current;
    queued.current = null;
    if (sentKey !== wanted.current) {
      if (next !== null && next.key === wanted.current) void send(next);
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
      if (stale && !restarted) return void send(request, undefined, true);
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
      return {
        key: sentKey,
        value: {
          tasks: before ? [...before.tasks, ...page.tasks] : page.tasks,
          ...(page.nextCursor !== undefined ? { cursor: page.nextCursor } : {}),
          partial: (before?.partial ?? false) || page.partial === true,
          endedEarly: page.endedEarly === true,
          loading: false,
          failed: false,
        },
      };
    });
  };
  const request: Request | null =
    key === null || query === null ? null : { key, environmentId, botId, query };
  const fire = useEffectEvent((sent: Request) => void send(sent));
  // oxlint-disable-next-line goat/react-effect-budget -- Waits for a quiet moment before asking the server, and forgets a query the field moved past.
  useEffect(() => {
    alive.current = true;
    wanted.current = key;
    const timer =
      key === null || query === null
        ? undefined
        : setTimeout(() => fire({ key, environmentId, botId, query }), TASK_SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      alive.current = false;
    };
  }, [key, environmentId, botId, query]);
  const value = key !== null && state?.key === key ? state.value : null;
  return {
    query,
    value,
    loadMore: () => {
      if (request !== null && value?.cursor && !value.loading) void send(request, value.cursor);
    },
    retry: () => {
      if (request !== null && value?.failed) void send(request, value.cursor);
    },
  };
}
