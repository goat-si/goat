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
import { useEffect, useRef, useState } from "react";

import { appAtomRegistry } from "../../state/atom-registry";
import { channelEnvironment } from "../../state/channels";

const NO_LIST: ChannelListBotThreadsResult = { rows: [], remoteWork: [], mainMessageCount: 0 };
const UNWRITTEN = "[[],[],[]]";
/** A press stopped because the computer went offline or Home moved on; it applies nothing. */
const CANCELLED = Symbol("history press cancelled");
type Walk = typeof EMPTY_WALK;

/**
 * A bot's older work behind Home's Show more, held in Home's own state for one scope: the
 * environment, the bot and one opening of the sheet, so reopening Home starts a new walk. Pages
 * only add tasks; the current list writes through into tasks the walk holds. A press that loses its
 * computer or its scope applies nothing, even if the computer comes back before it settles.
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
  readonly scope: string;
}) {
  const { environmentId, botId, enabled, scope } = input;
  const current = input.current ?? NO_LIST;
  const [held, setHeld] = useState({ scope, walk: EMPTY_WALK, written: UNWRITTEN });
  if (held.scope !== scope) setHeld({ scope, walk: EMPTY_WALK, written: UNWRITTEN });
  const walk = held.scope === scope ? held.walk : EMPTY_WALK;
  // Each time the computer goes offline the epoch moves, which ends any press started before it.
  const [connection, setConnection] = useState({ enabled, epoch: 0 });
  if (connection.enabled !== enabled) {
    setConnection({ enabled, epoch: enabled ? connection.epoch : connection.epoch + 1 });
    // The press that lost its computer stops counting as busy, so a reconnect can press again.
    if (!enabled && held.walk.loading)
      setHeld((state) => ({ ...state, walk: { ...state.walk, loading: false } }));
  }
  const live = useRef({ scope, epoch: connection.epoch });
  // oxlint-disable-next-line goat/react-effect-budget -- A running press checks the scope and connection it started with against the latest ones between its requests.
  useEffect(() => {
    live.current = { scope, epoch: connection.epoch };
  });
  // A server that answered a page walks history; offline its capabilities may not be known.
  const capabilities = walk.started
    ? { ...input.capabilities, goatBotTaskThreadsPaged: true }
    : input.capabilities;
  const view = botWorkHistoryView({
    walk,
    current,
    capabilities: capabilities as ExecutionEnvironmentCapabilities | undefined,
    botId,
    loaded: input.loaded && enabled,
  });
  if (held.scope === scope && view.reported !== held.written) {
    setHeld((state) =>
      state.scope === scope
        ? { ...state, written: view.reported, walk: writeThrough(state.walk, current) }
        : state,
    );
  }
  // The press in flight; one that lost its scope or connection no longer blocks a new one.
  const running = useRef<{ scope: string; epoch: number } | null>(null);
  const update = (target: string, change: (walk: Walk) => Walk) =>
    setHeld((state) => (state.scope === target ? { ...state, walk: change(state.walk) } : state));
  // An acknowledgement settles into the walk it was sent from, never a later one.
  function markRead(sentScope: string, taskId: ChannelTaskId, through: string) {
    if (!Number.isFinite(Date.parse(through))) return;
    update(sentScope, (state) => markWalkRead(state, taskId, through));
  }
  async function loadMore() {
    const same = (other: { scope: string; epoch: number } | null) =>
      other !== null && other.scope === live.current.scope && other.epoch === live.current.epoch;
    if (!view.hasMore || same(running.current) || environmentId === null) return;
    const press = { scope, epoch: connection.epoch };
    running.current = press;
    const valid = () => same(press);
    update(press.scope, (state) => ({ ...state, loading: true, failed: false }));
    const outcome = await readPress({
      environmentId,
      botId,
      capabilities: capabilities as ExecutionEnvironmentCapabilities | undefined,
      cursor: walk.cursor,
      listed: new Set(view.pressRows.map(botThreadKey)),
      valid,
    });
    if (outcome.kind === "applied")
      update(press.scope, (state) => applyHistoryPress(state, outcome.result));
    else if (running.current === press)
      update(press.scope, (state) => ({
        ...state,
        loading: false,
        failed: state.failed || outcome.kind === "failed",
      }));
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
    hasMore: view.hasMore,
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
