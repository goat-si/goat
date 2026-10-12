import {
  buildGoatBotTimeline,
  createGoatBotSendQueue,
  goatBotItemReaders,
  goatBotReplyingSince,
  initialGoatBotEnsure,
  retryGoatBotEnsure,
  settleGoatBotEnsure,
  startGoatBotEnsure,
  syncGoatBotEnsure,
  type GoatBotEnsureMachine,
  type GoatBotSendQueue,
} from "@goat/client-runtime/goatBot";
import { scopeThreadRef } from "@goat/client-runtime/environment";
import type {
  ChannelBotRef,
  ChannelGatewayError,
  EnvironmentId,
  OrchestrationV2ProjectedTurnItem,
} from "@goat/contracts";
import { useContext, useEffect, useMemo } from "react";
import { create } from "zustand";

import { useGlobalAgentStore } from "~/globalAgentStore";
import { randomUUID } from "~/lib/utils";
import { useEnvironmentShellsBootstrapped, useThreadShell } from "~/state/entities";
import {
  goatBotHomeReadBack,
  goatBotSupportUnknown,
  pickGoatBotEnvironment,
  resolveGoatBotAvailability,
  resolveGoatBotHomeSelection,
  type GoatBotEnvironmentInput,
} from "@goat/client-runtime/goatBot";
import { GoatBotChannelContext, type GoatBotChannelPort } from "./goatBotChannelPort";
import { useGoatBotEnvironments } from "./goatBotHooks";

interface Session {
  readonly homeKey: string;
  readonly notHome: { readonly homeKey: string; readonly settingsSnapshot: object | null } | null;
  readonly connected: boolean;
  readonly capability: boolean;
  readonly generation: number;
  readonly machine: GoatBotEnsureMachine;
  readonly port: GoatBotChannelPort | null;
  readonly canOperate: boolean;
  readonly legacyAutoRetried: boolean;
  readonly queue: GoatBotSendQueue;
}

const useSessions = create<{ sessions: ReadonlyMap<EnvironmentId, Session>; revision: number }>(
  () => ({ sessions: new Map(), revision: 0 }),
);
const EMPTY_ITEMS: ReadonlyArray<OrchestrationV2ProjectedTurnItem> = [];
const changed = () => useSessions.setState((state) => ({ revision: state.revision + 1 }));

function update(environmentId: EnvironmentId, session: Session) {
  useSessions.setState((state) => ({
    sessions: new Map(state.sessions).set(environmentId, session),
  }));
}

function newQueue(environmentId: EnvironmentId) {
  return createGoatBotSendQueue({
    onChange: changed,
    makeKey: randomUUID,
    canDispatch: (bot) => {
      const session = useSessions.getState().sessions.get(environmentId);
      return (
        session?.connected === true &&
        session.capability &&
        session.canOperate &&
        session.port !== null &&
        session.machine.ensure.state === "confirmed" &&
        session.machine.ensure.bot.environmentId === bot.environmentId &&
        session.machine.ensure.bot.threadId === bot.threadId
      );
    },
    send: async ({ clientKey, text, receivedAt, bot }) => {
      const port = useSessions.getState().sessions.get(environmentId)?.port;
      if (!port) throw new Error("GOAT Bot isn't available");
      const result = await port.ingest(bot.environmentId, {
        kind: "goat",
        connectionId: "goat",
        conversationKey: bot.threadId,
        externalMessageId: clientKey,
        idempotencyKey: clientKey,
        actor: {},
        replyAddress: { kind: "goat", environmentId: bot.environmentId, threadId: bot.threadId },
        text,
        attachments: [],
        receivedAt,
        intent: "message",
      });
      if (result.state === "rejected")
        return { requestKey: result.inputId, rejected: "GOAT Bot did not accept this message" };
      return { requestKey: result.inputId };
    },
  });
}

/** Sidebar observers also track reconnects while the bot screen is closed. */
function useObservedEnvironments() {
  const environments = useGoatBotEnvironments();
  const { supported, resolution } = resolveGoatBotHomeSelection(environments, null);
  const homeKey = !supported
    ? "legacy"
    : resolution.state === "claimed"
      ? `${resolution.claim.environmentId}:${resolution.claim.claimedAt}:${resolution.claim.claimId}`
      : resolution.state;
  useEffect(() => {
    const observed = new Map(environments.map((entry) => [entry.environmentId, entry]));
    for (const [environmentId, session] of useSessions.getState().sessions) {
      if (!observed.has(environmentId) && session.connected) {
        update(environmentId, {
          ...session,
          connected: false,
          machine: syncGoatBotEnsure(session.machine, null),
        });
      }
    }
    for (const environment of environments) {
      const previous = useSessions.getState().sessions.get(environment.environmentId);
      if (
        previous?.connected === environment.connected &&
        previous.capability === environment.supportsChannelLedger &&
        previous.homeKey === homeKey
      )
        continue;
      const generation =
        (previous?.generation ?? 0) + (environment.connected && !previous?.connected ? 1 : 0);
      const key =
        environment.connected && environment.supportsChannelLedger
          ? `${environment.environmentId}:${generation}:channel:${homeKey}`
          : null;
      update(environment.environmentId, {
        homeKey,
        notHome: previous?.notHome ?? null,
        connected: environment.connected,
        capability: environment.supportsChannelLedger,
        generation,
        machine: syncGoatBotEnsure(previous?.machine ?? initialGoatBotEnsure, key),
        port: previous?.port ?? null,
        canOperate: false,
        legacyAutoRetried: false,
        queue: previous?.queue ?? newQueue(environment.environmentId),
      });
    }
  }, [environments, homeKey]);
  return environments;
}

export function goatBotEnabled(
  port: GoatBotChannelPort | null,
  environment: GoatBotEnvironmentInput | null,
): boolean {
  return (
    port !== null &&
    (environment?.supportsChannelLedger === true || goatBotSupportUnknown(environment))
  );
}

export function useGoatBotEnabled() {
  const port = useContext(GoatBotChannelContext);
  const environments = useObservedEnvironments();
  const botRef = useGlobalAgentStore((state) => state.botRef);
  const home = useMemo(
    () => resolveGoatBotHomeSelection(environments, botRef),
    [environments, botRef],
  );
  const environment = pickGoatBotEnvironment(environments, botRef);
  const session = useSessions((state) =>
    environment === null ? undefined : state.sessions.get(environment.environmentId),
  );
  return {
    enabled: home.supported
      ? port !== null &&
        (home.resolution.state === "claimed" ||
          environments.some((entry) => entry.supportsChannelLedger))
      : goatBotEnabled(port, environment),
    environments,
    home,
    environment,
    generation:
      session?.connected === environment?.connected &&
      session?.capability === environment?.supportsChannelLedger
        ? (session?.generation ?? 0)
        : 0,
    port,
  };
}

const useCannotSend = (_environmentId: EnvironmentId | null) => false;

/** One ensure and send queue per environment, shared by the entry route and thread view. */
export function useGoatBotSession(visibleTurnItems = EMPTY_ITEMS) {
  const { enabled, environment, environments, home, port } = useGoatBotEnabled();
  const environmentId = environment?.environmentId ?? null;
  const bootstrapped = useEnvironmentShellsBootstrapped(environmentId);
  const session = useSessions((state) =>
    environmentId === null ? undefined : state.sessions.get(environmentId),
  );
  useSessions((state) => state.revision);
  const botRef = useGlobalAgentStore((state) => state.botRef);
  const legacyRef = useGlobalAgentStore((state) => state.ref);
  const legacyThreadRef = useMemo(
    () => (legacyRef === null ? null : scopeThreadRef(legacyRef.environmentId, legacyRef.threadId)),
    [legacyRef],
  );
  const legacyShell = useThreadShell(legacyThreadRef);
  const legacyStopped =
    legacyRef?.environmentId === environmentId && legacyShell?.runtime?.activeRunId === null;
  // The transport supplies a hook, installed for the lifetime of the app provider.
  // oxlint-disable-next-line react/hooks -- The channel port owns its permission hook.
  const useCanSend = port?.useCanSend ?? useCannotSend;
  // oxlint-disable-next-line react/hooks -- Invoke the injected hook unconditionally.
  const canOperate = useCanSend(environmentId);

  const homeKey = !home.supported
    ? "legacy"
    : home.resolution.state === "claimed"
      ? `${home.resolution.claim.environmentId}:${home.resolution.claim.claimedAt}:${home.resolution.claim.claimId}`
      : home.resolution.state;
  const settingsSnapshot = environment?.settingsSnapshot ?? null;
  const homeReady = !home.supported || goatBotHomeReadBack(home);
  useEffect(() => {
    if (environmentId === null || session === undefined) return;
    let current = useSessions.getState().sessions.get(environmentId);
    if (!current) return;
    // A not_home refusal waits for observed evidence, including across manual retry and reconnect.
    if (current.notHome !== null) {
      if (
        current.notHome.homeKey === homeKey &&
        current.notHome.settingsSnapshot === settingsSnapshot
      )
        return;
      current = { ...current, notHome: null, machine: retryGoatBotEnsure(current.machine) };
      update(environmentId, current);
    }
    let machine = current.machine;
    let legacyAutoRetried = current.port === port ? current.legacyAutoRetried : false;
    if (current.port !== port) machine = retryGoatBotEnsure(machine);
    if (machine.ensure.state === "legacy_active" && legacyStopped && !legacyAutoRetried) {
      machine = retryGoatBotEnsure(machine);
      legacyAutoRetried = true;
    }
    if (
      machine !== current.machine ||
      current.port !== port ||
      current.canOperate !== canOperate ||
      current.legacyAutoRetried !== legacyAutoRetried
    ) {
      current = { ...current, port, canOperate, legacyAutoRetried, machine };
      update(environmentId, current);
    }
    if (
      !homeReady ||
      !enabled ||
      !current.capability ||
      !bootstrapped ||
      !current.connected ||
      !port ||
      machine.ensure.state !== "idle"
    )
      return;
    const request = startGoatBotEnsure(machine);
    update(environmentId, { ...current, machine: request.machine });
    const candidateThreadId =
      legacyRef?.environmentId === environmentId &&
      legacyShell?.archivedAt == null &&
      legacyShell?.deletedAt == null
        ? legacyRef.threadId
        : undefined;
    const settle = (result: Parameters<typeof settleGoatBotEnsure>[2], bot?: ChannelBotRef) => {
      const latest = useSessions.getState().sessions.get(environmentId);
      if (!latest) return;
      const settled = settleGoatBotEnsure(latest.machine, request.token, result);
      if (settled === latest.machine) return;
      update(environmentId, { ...latest, machine: settled });
      if (bot) useGlobalAgentStore.getState().setBotRef(bot);
    };
    void (async () => {
      try {
        const bot = await port.ensureBot(
          environmentId,
          candidateThreadId === undefined ? {} : { candidateThreadId },
        );
        settle({ kind: "confirmed", bot }, bot);
      } catch (error) {
        const gatewayError = error as ChannelGatewayError | null;
        if (gatewayError?.reason === "not_home") {
          const latest = useSessions.getState().sessions.get(environmentId);
          if (latest?.machine.pending === request.token) {
            update(environmentId, {
              ...latest,
              machine: retryGoatBotEnsure(latest.machine),
              notHome: { homeKey, settingsSnapshot },
            });
          }
          return;
        }
        settle(
          gatewayError?.reason === "legacy_active"
            ? { kind: "legacy_active" }
            : {
                kind: "failed",
                message: error instanceof Error ? error.message : "Couldn't reach GOAT Bot",
              },
        );
      }
    })();
  }, [
    environmentId,
    homeReady,
    homeKey,
    settingsSnapshot,
    enabled,
    bootstrapped,
    port,
    session,
    canOperate,
    legacyStopped,
    legacyRef,
    legacyShell,
  ]);

  const availability = !enabled
    ? { kind: "unsupported" as const }
    : resolveGoatBotAvailability({
        environments,
        botRef,
        ensure:
          session?.connected === environment?.connected &&
          session?.capability === environment?.supportsChannelLedger &&
          session?.port === port &&
          session.homeKey === homeKey
            ? session.machine.ensure
            : { state: "idle" },
      });
  const queue = session?.queue;
  useEffect(() => {
    const keys = new Set<string>();
    for (const { item } of visibleTurnItems) {
      if (item.type !== "user_message") continue;
      const presentation = goatBotItemReaders.message(item);
      if (presentation?.requestKey) keys.add(presentation.requestKey);
      if (presentation?.clientKey) keys.add(presentation.clientKey);
    }
    // An entry-route consumer has no projection and must not clear a thread consumer's keys.
    if (visibleTurnItems !== EMPTY_ITEMS) queue?.acknowledge(keys);
  }, [queue, visibleTurnItems]);
  const rows = buildGoatBotTimeline({
    visibleTurnItems,
    pendingInputs: queue?.pendingInputs() ?? [],
    readers: goatBotItemReaders,
  });
  return {
    confirmedBot: availability.kind === "ready" ? availability.bot : null,
    availability,
    canOperate,
    rows,
    replyingSince: goatBotReplyingSince({ visibleTurnItems, readers: goatBotItemReaders }),
    onSend: (text: string) => {
      if (availability.kind === "ready" && canOperate) queue?.submit(text, availability.bot);
    },
    onRetryInput: (key: string) => {
      if (availability.kind === "ready" && canOperate) queue?.retry(key);
    },
    onRetryAvailability: () => {
      if (environmentId === null) return;
      const current = useSessions.getState().sessions.get(environmentId);
      if (current && current.notHome === null)
        update(environmentId, { ...current, machine: retryGoatBotEnsure(current.machine) });
    },
  };
}
