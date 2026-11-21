import {
  allowsGoatBotAlert,
  attentionCursorKey,
  encodeBotAttentionRequest,
  resolveBotAttentionDecision,
  goatBotAttentionTitle,
  readGoatBotAttentionTarget,
  watchGoatBotAttention,
} from "@goat/client-runtime/goatBot";
import { MAIN_BOT_ID, type EnvironmentId } from "@goat/contracts";
import {
  type ChannelAttentionEvent,
  type GoatBotAlerts,
} from "@goat/contracts/channel-bot-attention";
import type { AnyRouter } from "@tanstack/react-router";
import { Atom, type AtomRegistry } from "effect/reactivity";
import { useGlobalAgentStore } from "../../globalAgentStore";
import { orchestrationEnvironment } from "../../state/orchestration";
import { serverEnvironment } from "../../state/server";
import { channelEnvironment } from "../../state/channels";
import { environmentPresentations, environmentSummaries } from "../../state/presentation";

export function createGoatBotAttentionPresenter(input: {
  readonly focused: (event: ChannelAttentionEvent) => boolean;
  readonly show: (
    title: string,
    options: NotificationOptions,
    event: ChannelAttentionEvent,
  ) => void;
}) {
  let lastSequence = 0;
  return (event: ChannelAttentionEvent, mode: GoatBotAlerts) => {
    if (event.sequence <= lastSequence) return;
    lastSequence = event.sequence;
    if (allowsGoatBotAlert(mode, event) && !input.focused(event)) {
      input.show(
        goatBotAttentionTitle(event),
        {
          tag: `${event.environmentId}:${event.eventId}`,
        },
        event,
      );
    }
  };
}

function focusedTask(router: AnyRouter, event: ChannelAttentionEvent) {
  const { pathname, search } = router.state.location;
  const environmentId =
    search.attentionEnvironment ?? useGlobalAgentStore.getState().botRef?.environmentId;
  return (
    document.visibilityState === "visible" &&
    document.hasFocus() &&
    pathname === "/bot" &&
    environmentId === event.environmentId &&
    (search.bot ?? MAIN_BOT_ID) === event.botId &&
    search.task === event.taskId
  );
}

export function startGoatBotAttentionNotifications(
  registry: AtomRegistry.AtomRegistry,
  router: AnyRouter,
) {
  const watches = new Map<EnvironmentId, () => void>();
  const watch = (environmentId: EnvironmentId) => {
    const cursorKey = attentionCursorKey(environmentId);
    const present = createGoatBotAttentionPresenter({
      focused: (event) => focusedTask(router, event),
      show: (title, options, event) => {
        if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
        const notification = new Notification(title, options);
        notification.addEventListener(
          "click",
          () => {
            notification.close();
            void (async () => {
              const target = await readGoatBotAttentionTarget(registry, channelEnvironment, event);
              if (target === null) return;
              window.focus();
              await window.desktopBridge?.revealWindow?.().catch(() => undefined);
              if (!registry.get(channelEnvironment.listBotAttention.permissionAtom(environmentId)))
                return;
              const decision =
                target.request === undefined
                  ? null
                  : await resolveBotAttentionDecision(
                      registry,
                      {
                        decisions: serverEnvironment,
                        orchestration: orchestrationEnvironment,
                        connected: (id) =>
                          registry.get(environmentPresentations.presentationAtom(id))?.connection
                            .phase === "connected",
                      },
                      environmentId,
                      target.task,
                      target.request,
                    );
              if (!registry.get(channelEnvironment.listBotAttention.permissionAtom(environmentId)))
                return;
              if (decision !== null) {
                await router.navigate({ to: "/decisions", search: decision });
                return;
              }
              await router.navigate({
                to: "/bot",
                search: {
                  task: event.taskId,
                  ...(event.botId === MAIN_BOT_ID ? {} : { bot: event.botId }),
                  attentionEnvironment: environmentId,
                  ...(target.task.originAddress.kind === "goat"
                    ? {}
                    : { attentionDetail: "external" }),
                  ...(target.request === undefined
                    ? {}
                    : {
                        attentionNative: encodeBotAttentionRequest(target.request),
                        attentionGeneration: event.generation,
                      }),
                  ...(target.requestId === undefined ? {} : { attentionRequest: target.requestId }),
                },
              });
            })().catch((cause) => console.warn("GOAT Bot could not open the alert", cause));
          },
          { once: true },
        );
      },
    });
    const enabled = Atom.make(
      (get) =>
        get(environmentPresentations.presentationAtom(environmentId))?.serverConfig?.environment
          .capabilities.goatBotAttention === true &&
        get(channelEnvironment.listBotAttention.permissionAtom(environmentId)),
    );
    let stop = () => {};
    const unsubscribe = registry.subscribe(
      enabled,
      (active) => {
        stop();
        stop = active
          ? watchGoatBotAttention({
              registry,
              channels: channelEnvironment,
              handoffFeed: serverEnvironment.decisionFeed(environmentId),
              environmentId,
              onError: (cause) => console.warn("GOAT Bot could not deliver an alert", cause),
              present,
              readCursor: async () => {
                const saved = localStorage.getItem(cursorKey);
                const cursor = saved === null ? NaN : Number(saved);
                return Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : undefined;
              },
              writeCursor: async (cursor) => localStorage.setItem(cursorKey, String(cursor)),
              withLock: async (operation) => {
                if (navigator.locks === undefined) await operation();
                else await navigator.locks.request(cursorKey, operation);
              },
            })
          : () => {};
      },
      { immediate: true },
    );
    return () => {
      unsubscribe();
      stop();
    };
  };
  const unsubscribe = registry.subscribe(
    environmentSummaries.environmentIdsAtom,
    (ids) => {
      for (const [id, stop] of watches) {
        if (!ids.includes(id)) {
          stop();
          watches.delete(id);
        }
      }
      for (const id of ids) {
        if (!watches.has(id)) watches.set(id, watch(id));
      }
    },
    { immediate: true },
  );
  return () => {
    unsubscribe();
    for (const stop of watches.values()) stop();
    watches.clear();
  };
}
