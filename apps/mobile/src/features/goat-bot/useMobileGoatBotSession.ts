import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  buildGoatBotTimeline,
  createGoatBotSendQueue,
  goatBotItemReaders,
  goatBotHomeReadBack,
  pickGoatBotEnvironment,
  resolveGoatBotAvailability,
  canSendToGoatBot,
  goatBotReplyingSince,
  initialGoatBotEnsure,
  retryGoatBotEnsure,
  settleGoatBotEnsure,
  startGoatBotEnsure,
  syncGoatBotEnsure,
  type GoatBotEnsureMachine,
  type GoatBotAvailability,
  type GoatBotPendingInput,
} from "@goat/client-runtime/goatBot";
import { goatBotIngestInput } from "@goat/client-runtime/state/channels";
import { scopeThreadRef } from "@goat/client-runtime/environment";
import { runAtomCommand, squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import type { ChannelBotRef, EnvironmentId } from "@goat/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";

import { environmentCatalog } from "../../connection/catalog";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { channelEnvironment } from "../../state/channels";
import { updateMobilePreferencesAtom } from "../../state/preferences";
import { useThreadVisibleTurnItems } from "../../state/use-thread-detail";
import { useThreadShell } from "../../state/entities";
import { useEnvironmentShellReadiness } from "../../state/shell";
import { useMobileGoatBotHomeMode } from "./useMobileGoatBotHomeMode";
import { pickMobileGoatBotEnvironment } from "./goatBotHomeMode";
import {
  settleMobileGoatBotEnsure,
  goatBotSessionKey,
  mobileGoatBotWaitingForHome,
  type MobileGoatBotNotHome,
  type MobileGoatBotEnsureDestination,
} from "./mobileGoatBotEnsure";

interface Session {
  readonly machine: GoatBotEnsureMachine;
  readonly notHome: MobileGoatBotNotHome | null;
  readonly bot: ChannelBotRef | null;
  readonly connected: boolean;
  readonly canOperate: boolean;
  readonly queue: ReturnType<typeof createGoatBotSendQueue>;
  readonly pending: ReadonlyArray<GoatBotPendingInput>;
}

const sessions = new Map<EnvironmentId, Session>();
const listeners = new Set<() => void>();
const EMPTY_PENDING: ReadonlyArray<GoatBotPendingInput> = [];
const NO_PERMISSION = Atom.make(false);
const NO_CONNECTION = Atom.make(null);
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
function update(environmentId: EnvironmentId, session: Session) {
  sessions.set(environmentId, session);
  for (const listener of listeners) listener();
}

function newSession(environmentId: EnvironmentId): Session {
  const queue = createGoatBotSendQueue({
    makeKey: uuidv4,
    onChange: () => {
      const current = sessions.get(environmentId);
      if (current) update(environmentId, { ...current, pending: current.queue.pendingInputs() });
    },
    canDispatch: (bot) => {
      const current = sessions.get(environmentId);
      return (
        current?.connected === true &&
        current.canOperate &&
        current.machine.ensure.state === "confirmed" &&
        current.bot?.environmentId === bot.environmentId &&
        current.bot.threadId === bot.threadId
      );
    },
    send: async ({ clientKey, text, receivedAt, bot }) => {
      const fullBot = sessions.get(environmentId)?.bot;
      if (
        !fullBot ||
        fullBot.threadId !== bot.threadId ||
        fullBot.environmentId !== bot.environmentId
      ) {
        throw new Error("GOAT Bot isn't available");
      }
      const result = await runAtomCommand(appAtomRegistry, channelEnvironment.ingest, {
        environmentId,
        input: goatBotIngestInput({ bot: fullBot, text, clientMessageId: clientKey, receivedAt }),
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      return {
        requestKey: result.value.inputId,
        ...(result.value.state === "rejected"
          ? { rejected: "GOAT Bot did not accept this message" }
          : {}),
      };
    },
  });
  return {
    machine: initialGoatBotEnsure,
    notHome: null,
    bot: null,
    connected: false,
    canOperate: false,
    queue,
    pending: EMPTY_PENDING,
  };
}

/** A stable snapshot and a single ensure/send queue per destination environment. */
export function useMobileGoatBotSession(visible: boolean) {
  const home = useMobileGoatBotHomeMode();
  const environment = home.home.supported
    ? pickGoatBotEnvironment(home.environments, home.botRef)
    : pickMobileGoatBotEnvironment(home.environments, home.botRef);
  const environmentId = environment?.environmentId ?? null;
  const connection = useAtomValue(
    environmentId === null ? NO_CONNECTION : environmentCatalog.stateAtom(environmentId),
  );
  const generation =
    connection !== null && AsyncResult.isSuccess(connection) ? connection.value.generation : null;
  const canEnsure = useAtomValue(
    environmentId === null
      ? NO_PERMISSION
      : channelEnvironment.ensureBot.permissionAtom(environmentId),
  );
  const canIngest = useAtomValue(
    environmentId === null
      ? NO_PERMISSION
      : channelEnvironment.ingest.permissionAtom(environmentId),
  );
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  // oxlint-disable react/preserve-manual-memoization -- External-store reads are mutable; useSyncExternalStore needs a stable reader.
  const getSnapshot = useCallback(
    () => (environmentId === null ? undefined : sessions.get(environmentId)),
    [environmentId],
  );
  // oxlint-enable react/preserve-manual-memoization
  const session = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const connected = environment?.connected === true;
  const capable = environment?.supportsChannelLedger === true;
  const selection = home.home;
  const homeKey = !selection.supported
    ? "legacy"
    : selection.resolution.state === "claimed"
      ? `${selection.resolution.claim.environmentId}:${selection.resolution.claim.claimedAt}:${selection.resolution.claim.claimId}`
      : selection.resolution.state;
  const settingsSnapshot = environment?.settingsSnapshot ?? null;
  const homeReady = home.loaded && (!selection.supported || goatBotHomeReadBack(selection));
  const connectionKey =
    connected && capable ? goatBotSessionKey({ environmentId, generation, homeKey }) : null;
  const canOperate =
    canEnsure &&
    canIngest &&
    homeReady &&
    !mobileGoatBotWaitingForHome(session?.notHome ?? null, homeKey, settingsSnapshot);
  const selectedDestination = useRef<
    (MobileGoatBotEnsureDestination & { readonly homeKey: string }) | null
  >(null);
  useLayoutEffect(() => {
    selectedDestination.current = { environmentId, connectionKey, homeKey };
    return () => {
      selectedDestination.current = null;
      if (environmentId === null) return;
      const previous = sessions.get(environmentId);
      // Returning to this environment must start a fresh request, even if the
      // old connection generation has not changed.
      if (previous && previous.machine.pending !== null) {
        update(environmentId, {
          ...previous,
          machine: retryGoatBotEnsure(previous.machine),
        });
      }
    };
  }, [environmentId, connectionKey, homeKey]);

  useEffect(() => {
    if (environmentId === null) return;
    const previous = sessions.get(environmentId) ?? session ?? newSession(environmentId);
    const waiting = mobileGoatBotWaitingForHome(previous.notHome, homeKey, settingsSnapshot);
    const notHome = waiting ? previous.notHome : null;
    const machine = syncGoatBotEnsure(
      previous.notHome !== null && !waiting
        ? retryGoatBotEnsure(previous.machine)
        : previous.machine,
      connectionKey,
    );
    let current = previous;
    if (
      !sessions.has(environmentId) ||
      machine !== previous.machine ||
      notHome !== previous.notHome ||
      previous.connected !== connected ||
      previous.canOperate !== canOperate
    ) {
      current = {
        ...previous,
        machine,
        notHome,
        connected,
        canOperate,
        bot: machine === previous.machine ? previous.bot : null,
      };
      update(environmentId, current);
    }
    if (
      !visible ||
      !home.loaded ||
      !homeReady ||
      waiting ||
      connectionKey === null ||
      !canEnsure ||
      current.machine.ensure.state !== "idle"
    )
      return;
    const request = startGoatBotEnsure(current.machine);
    update(environmentId, { ...current, machine: request.machine });
    const settle = (
      result: Parameters<typeof settleGoatBotEnsure>[2],
      bot: ChannelBotRef | null = null,
      notHome = false,
    ) => {
      const latest = sessions.get(environmentId);
      if (!latest) return;
      const liveConnection = appAtomRegistry.get(environmentCatalog.stateAtom(environmentId));
      const selected = selectedDestination.current;
      const liveConnectionKey =
        AsyncResult.isSuccess(liveConnection) &&
        liveConnection.value.phase === "connected" &&
        selected
          ? goatBotSessionKey({
              environmentId,
              generation: liveConnection.value.generation,
              homeKey: selected.homeKey,
            })
          : null;
      const settled = settleMobileGoatBotEnsure(
        latest.machine,
        request.token,
        result,
        { environmentId, connectionKey },
        selected && {
          environmentId: selected.environmentId,
          connectionKey: selected.connectionKey === liveConnectionKey ? liveConnectionKey : null,
        },
      );
      if (settled === latest.machine) return;
      update(environmentId, {
        ...latest,
        machine: notHome ? retryGoatBotEnsure(latest.machine) : settled,
        notHome: notHome ? { homeKey, settingsSnapshot } : null,
        bot,
        canOperate: notHome ? false : latest.canOperate,
      });
      if (bot) savePreferences({ goatBotRef: bot });
    };
    void (async () => {
      try {
        const result = await runAtomCommand(appAtomRegistry, channelEnvironment.ensureBot, {
          environmentId,
          input: {},
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        settle({ kind: "confirmed", bot: result.value }, result.value);
      } catch (error) {
        const reason =
          typeof error === "object" && error !== null && "reason" in error ? error.reason : null;
        const legacy = reason === "legacy_active";
        settle(
          legacy
            ? { kind: "legacy_active" }
            : {
                kind: "failed",
                message: error instanceof Error ? error.message : "Couldn't reach GOAT Bot",
              },
          null,
          reason === "not_home",
        );
      }
    })();
  }, [
    environmentId,
    connected,
    connectionKey,
    canOperate,
    canEnsure,
    home.loaded,
    homeReady,
    homeKey,
    settingsSnapshot,
    visible,
    savePreferences,
    session,
  ]);

  const ensure =
    session?.machine.generation === connectionKey
      ? session.machine.ensure
      : initialGoatBotEnsure.ensure;
  const confirmedBot = ensure.state === "confirmed" ? (session?.bot ?? null) : null;
  const bot = confirmedBot ?? home.botRef;
  const threadRef = useMemo(
    () => (visible && bot ? scopeThreadRef(bot.environmentId, bot.threadId) : null),
    [visible, bot],
  );
  const shell = useThreadShell(threadRef);
  const shellReadiness = useEnvironmentShellReadiness(
    visible ? (bot?.environmentId ?? null) : null,
  );
  const seenBot = useRef<string | null>(null);
  useEffect(() => {
    if (!visible || !confirmedBot || shellReadiness.status !== "live") return;
    const key = `${confirmedBot.environmentId}:${confirmedBot.threadId}`;
    if (shell !== null && shell.deletedAt == null) {
      seenBot.current = key;
      return;
    }
    // A live snapshot can precede the bot-creation event. Re-ensure only a
    // deleted shell or a bot we already observed before it disappeared.
    if (shell?.deletedAt == null && seenBot.current !== key) return;
    const current = sessions.get(confirmedBot.environmentId);
    if (current?.machine.ensure.state === "confirmed") {
      seenBot.current = null;
      update(confirmedBot.environmentId, {
        ...current,
        bot: null,
        machine: retryGoatBotEnsure(current.machine),
      });
    }
  }, [visible, confirmedBot, shell, shellReadiness.status]);
  const visibleTurnItems = useThreadVisibleTurnItems({
    environmentId: visible ? (bot?.environmentId ?? null) : null,
    threadId: visible ? (bot?.threadId ?? null) : null,
  });
  const queue = session?.queue;
  useEffect(() => {
    if (!visible || !queue) return;
    const keys = new Set<string>();
    for (const { item } of visibleTurnItems) {
      if (item.type !== "user_message") continue;
      const presentation = goatBotItemReaders.message(item);
      if (presentation?.requestKey) keys.add(presentation.requestKey);
      if (presentation?.clientKey) keys.add(presentation.clientKey);
    }
    queue.acknowledge(keys);
  }, [visible, queue, visibleTurnItems]);
  const pendingInputs = session?.pending ?? EMPTY_PENDING;
  const rows = useMemo(
    () => buildGoatBotTimeline({ visibleTurnItems, pendingInputs, readers: goatBotItemReaders }),
    [visibleTurnItems, pendingInputs],
  );
  const replyingSince = useMemo(
    () => goatBotReplyingSince({ visibleTurnItems, readers: goatBotItemReaders }),
    [visibleTurnItems],
  );
  const resolved: GoatBotAvailability =
    !selection.supported && environment === null && home.botRef !== null
      ? { kind: "offline", environmentId: home.botRef.environmentId }
      : resolveGoatBotAvailability({
          environments: selection.supported ? home.environments : environment ? [environment] : [],
          botRef: home.botRef,
          ensure,
        });
  const availability: GoatBotAvailability["kind"] | "permission" =
    resolved.kind === "ready" || resolved.kind === "connecting"
      ? connected && capable && (!canEnsure || !canIngest)
        ? "permission"
        : resolved.kind
      : resolved.kind;
  const canSend =
    visible && homeReady && canSendToGoatBot(resolved, canOperate) && confirmedBot !== null;
  const onSend = useCallback(
    (text: string) => {
      if (!canSend || !confirmedBot || !text.trim()) return false;
      queue?.submit(text.trim(), confirmedBot);
      return true;
    },
    [canSend, confirmedBot, queue],
  );
  const onRetryInput = useCallback(
    (key: string) => {
      if (canSend) queue?.retry(key);
    },
    [canSend, queue],
  );
  const onRetryAvailability = useCallback(() => {
    if (environmentId === null) return;
    const current = sessions.get(environmentId);
    if (mobileGoatBotWaitingForHome(current?.notHome ?? null, homeKey, settingsSnapshot)) return;
    if (current)
      update(environmentId, {
        ...current,
        bot: null,
        machine: retryGoatBotEnsure(current.machine),
      });
  }, [environmentId, homeKey, settingsSnapshot]);
  return {
    rows,
    replyingSince,
    canSend,
    availability,
    homeLabel: resolved.kind === "home_offline" ? resolved.label : null,
    error: ensure.state === "failed" ? ensure.message : null,
    onSend,
    onRetryInput,
    onRetryAvailability,
  };
}
