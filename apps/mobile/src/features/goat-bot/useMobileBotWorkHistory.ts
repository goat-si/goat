import {
  applyHistoryPress,
  botThreadKey,
  botThreadsHistoryInput,
  botWorkHistoryView,
  EMPTY_WALK,
  markWalkRead,
  readBotThreadHistory,
  writeThrough,
} from "@goat/client-runtime/goatBot";
import { runAtomCommand } from "@goat/client-runtime/state/runtime";
import type {
  BotId,
  ChannelListBotThreadsResult,
  ChannelTaskId,
  EnvironmentId,
  ExecutionEnvironmentCapabilities,
} from "@goat/contracts";
import { useLayoutEffect, useRef, useState } from "react";

import { appAtomRegistry } from "../../state/atom-registry";
import { channelEnvironment } from "../../state/channels";

const NO_LIST: ChannelListBotThreadsResult = { rows: [], remoteWork: [], mainMessageCount: 0 };
const UNWRITTEN = "[[],[],[]]";
/** A press stopped because the computer went offline or Home moved on; it applies nothing. */
const CANCELLED = Symbol("history press cancelled");
type Walk = typeof EMPTY_WALK;

/**
 * A bot's older work behind Home's Show more, in Home's own state. Each change of scope starts a
 * walk with a new identity, even back to a scope seen before. Pages only add tasks; the current list
 * writes through. A press that loses its computer, its walk or its Home applies nothing.
 */
export function useMobileBotWorkHistory(input: {
  readonly environmentId: EnvironmentId | null;
  readonly botId: BotId | null;
  readonly capabilities: ExecutionEnvironmentCapabilities | undefined;
  readonly current: ChannelListBotThreadsResult | null;
  /** A settled read of the current list. */
  readonly loaded: boolean;
  /** The computer is connected and lists this bot's tasks; offline nothing is read. */
  readonly enabled: boolean;
  /** One opening of Home on one computer for one bot: pages belong to it. */
  readonly scope: string;
  /** The computer and bot alone: an accepted read mark is a fact about them, whichever walk shows. */
  readonly owner: string;
}) {
  const { environmentId, botId, enabled, scope, owner } = input;
  const current = input.current ?? NO_LIST;
  const [held, setHeld] = useState({
    scope,
    owner,
    id: 0,
    epoch: 0,
    walk: EMPTY_WALK,
    written: UNWRITTEN,
  });
  if (held.scope !== scope)
    setHeld((state) => ({
      ...state,
      scope,
      owner,
      id: state.id + 1,
      walk: EMPTY_WALK,
      written: UNWRITTEN,
    }));
  const walk = held.scope === scope ? held.walk : EMPTY_WALK;
  // Losing the computer or its paged history moves the epoch, ending any press started before it
  // before its next request. The press stops counting as busy and the failure notice goes, since
  // nothing can be retried until Show more returns.
  const paged = botThreadsHistoryInput(input.capabilities, botId) !== null;
  const reachable = enabled && paged;
  const [wasReachable, setWasReachable] = useState(reachable);
  if (wasReachable !== reachable) {
    setWasReachable(reachable);
    if (!reachable)
      setHeld((state) => ({
        ...state,
        epoch: state.epoch + 1,
        walk: { ...state.walk, loading: false, failed: false },
      }));
  }
  type Press = { readonly id: number; readonly epoch: number };
  // Null once Home unmounts, which ends any press as going offline does. Set at commit, so a press
  // resuming right after a disconnect or unmount sees it.
  const live = useRef<Press | null>({ id: held.id, epoch: held.epoch });
  // oxlint-disable-next-line goat/react-effect-budget -- A running press checks the walk, connection and mount it started with against the committed ones between its requests.
  useLayoutEffect(() => {
    live.current = { id: held.id, epoch: held.epoch };
    return () => {
      live.current = null;
    };
  });
  // Rows a started walk read stay listed, offline too, where capabilities may be unknown; offering
  // and sending reads follow what the connected computer reports now.
  const listedCapabilities = walk.started
    ? { ...input.capabilities, goatBotTaskThreadsPaged: true }
    : input.capabilities;
  const view = botWorkHistoryView({
    walk,
    current,
    capabilities: listedCapabilities as ExecutionEnvironmentCapabilities | undefined,
    botId,
    loaded: input.loaded && enabled,
  });
  const hasMore = view.hasMore && paged;
  if (held.scope === scope && view.reported !== held.written) {
    const id = held.id;
    setHeld((state) =>
      state.id === id
        ? { ...state, written: view.reported, walk: writeThrough(state.walk, current) }
        : state,
    );
  }
  // The press in flight; one that lost its walk, connection or Home no longer blocks a new one.
  const running = useRef<Press | null>(null);
  /** The press is still this Home's, on the same walk and connection. */
  const mine = (press: Press | null) =>
    press !== null &&
    live.current !== null &&
    press.id === live.current.id &&
    press.epoch === live.current.epoch;
  // A result lands only in the walk it was started for (compared inside the state update) and
  // never after unmount; a disconnect stops further requests and any failure notice.
  const write = (press: Press, change: (walk: Walk) => Walk) => {
    if (!mine(press)) return;
    setHeld((state) =>
      state.id === press.id && state.epoch === press.epoch
        ? { ...state, walk: change(state.walk) }
        : state,
    );
  };
  // An accepted read mark applies to whichever walk shows its computer and bot. True when it is
  // this mounted Home's computer and bot, so the caller may reread the current list.
  function markRead(sentOwner: string, taskId: ChannelTaskId, through: string) {
    if (live.current === null) return false;
    if (Number.isFinite(Date.parse(through)))
      setHeld((state) =>
        state.owner === sentOwner
          ? { ...state, walk: markWalkRead(state.walk, taskId, through) }
          : state,
      );
    return sentOwner === owner;
  }
  async function loadMore() {
    if (!hasMore || mine(running.current) || environmentId === null) return;
    const press = { id: held.id, epoch: held.epoch };
    // A press from a render before Home's walk or connection changed sends nothing.
    if (!mine(press)) return;
    running.current = press;
    write(press, (state) => ({ ...state, loading: true, failed: false }));
    const outcome = await readPress({
      environmentId,
      botId,
      capabilities: input.capabilities,
      cursor: walk.cursor,
      listed: new Set(view.pressRows.map(botThreadKey)),
      valid: () => mine(press),
    });
    // A cancelled press writes nothing: whatever ended it already reset the walk or its loading.
    if (outcome.kind === "applied")
      write(press, (state) => applyHistoryPress(state, outcome.result));
    else if (outcome.kind === "failed")
      write(press, (state) => ({ ...state, loading: false, failed: true }));
    if (running.current === press) running.current = null;
  }
  return {
    supported: view.supported,
    markRead,
    currentTaskIds: view.currentTaskIds,
    rows: view.rows,
    remoteWork: view.remoteWork,
    launchesTruncated: view.launchesTruncated,
    incomplete: view.incomplete,
    hasMore,
    loading: walk.loading,
    failed: walk.failed,
    loadMore,
  };
}

/**
 * Reads one press of history pages. It stops before each request, after each answer and before
 * returning when the press is no longer valid, so a cancelled press applies nothing and does not
 * count as a failure.
 */
async function readPress(input: {
  readonly environmentId: EnvironmentId;
  readonly botId: BotId | null;
  readonly capabilities: ExecutionEnvironmentCapabilities | undefined;
  readonly cursor: string | undefined;
  readonly listed: ReadonlySet<string>;
  readonly valid: () => boolean;
}): Promise<
  | { readonly kind: "applied"; readonly result: Parameters<typeof applyHistoryPress>[1] }
  | { readonly kind: "cancelled" | "failed" }
> {
  try {
    const result = await readBotThreadHistory({
      from: input.cursor,
      listed: input.listed,
      wanted: 5,
      read: async (cursor) => {
        if (!input.valid()) throw CANCELLED;
        const request = botThreadsHistoryInput(input.capabilities, input.botId, cursor);
        if (request === null) throw new Error("History is unavailable");
        const answer = await runAtomCommand(
          appAtomRegistry,
          channelEnvironment.listBotThreadsPage,
          { environmentId: input.environmentId, input: request },
          { label: "GOAT Bot older work", reportFailure: false },
        );
        if (!input.valid()) throw CANCELLED;
        if (answer._tag !== "Success") throw new Error("History could not be read");
        return answer.value;
      },
    });
    return input.valid() ? { kind: "applied", result } : { kind: "cancelled" };
  } catch (error) {
    return { kind: error === CANCELLED || !input.valid() ? "cancelled" : "failed" };
  }
}
