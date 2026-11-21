import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import type { NotificationResponse } from "expo-notifications";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { resolveMobileBotAttentionLink } from "./goatBotAttentionLink";
import { consumeLastAgentNotificationResponse } from "./notificationResponseConsumer";

import {
  extractAgentNotificationDeepLink,
  routeAgentNotificationResponseOnce,
} from "./notificationPayload";

function responseWithData(data: Record<string, unknown>, identifier = "notification-1") {
  return {
    notification: {
      request: {
        identifier,
        content: {
          data,
        },
      },
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("consumeLastAgentNotificationResponse", () => {
  it("reports routing failures before clearing the response", async () => {
    const cause = new Error("notification routing unavailable");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = responseWithData({}, "notification-route") as NotificationResponse;
    const clearLastResponse = vi.fn(() => Promise.resolve());

    await consumeLastAgentNotificationResponse({
      getLastResponse: () => Promise.resolve(response),
      clearLastResponse,
      handleResponse: () => {
        throw cause;
      },
    });

    expect(clearLastResponse).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      expect.objectContaining({
        _tag: "NotificationNavigationError",
        operation: "route",
        notificationId: "notification-route",
      }),
    );
  });
});

describe("extractAgentNotificationDeepLink", () => {
  it("uses explicit deep links from APNs payload data", () => {
    expect(
      extractAgentNotificationDeepLink(
        responseWithData({
          deepLink: "/threads/env/thread",
          environmentId: "ignored",
          threadId: "ignored",
        }),
      ),
    ).toBe("/threads/env/thread");
  });

  it("falls back to the thread route from environment and thread ids", () => {
    expect(
      extractAgentNotificationDeepLink(
        responseWithData({
          environmentId: "env 1",
          threadId: "thread/2",
        }),
      ),
    ).toBe("/threads/env%201/thread%2F2");
  });

  it("falls back to ids when explicit deep link is not an agent thread route", () => {
    expect(
      extractAgentNotificationDeepLink(
        responseWithData({
          deepLink: "/",
          environmentId: "env",
          threadId: "thread",
        }),
      ),
    ).toBe("/threads/env/thread");
  });

  it("ignores malformed or external links", () => {
    expect(
      extractAgentNotificationDeepLink(responseWithData({ deepLink: "https://example.com" })),
    ).toBeNull();
    expect(
      extractAgentNotificationDeepLink(responseWithData({ deepLink: "/settings" })),
    ).toBeNull();
    expect(
      extractAgentNotificationDeepLink(responseWithData({ deepLink: "//example.com" })),
    ).toBeNull();
    expect(
      extractAgentNotificationDeepLink(responseWithData({ deepLink: "/threads/env/thread?x=1" })),
    ).toBeNull();
    expect(extractAgentNotificationDeepLink({})).toBeNull();
  });
});

describe("routeAgentNotificationResponseOnce", () => {
  it("retries a failed initial response and deduplicates it after navigation succeeds", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = responseWithData({ deepLink: "/threads/env/thread" }) as NotificationResponse;
    const handledResponseIds = new Set<string>();
    const navigate = vi.fn().mockImplementationOnce(() => {
      throw new Error("navigation not ready");
    });
    const clearLastResponse = vi.fn(() => Promise.resolve());
    const consume = () =>
      consumeLastAgentNotificationResponse({
        getLastResponse: () => Promise.resolve(response),
        clearLastResponse,
        handleResponse: (response) =>
          routeAgentNotificationResponseOnce({ handledResponseIds, response, navigate }),
      });

    await consume();
    expect(handledResponseIds.size).toBe(0);
    expect(clearLastResponse).not.toHaveBeenCalled();

    await consume();
    expect(navigate).toHaveBeenCalledTimes(2);
    expect(navigate).toHaveBeenLastCalledWith("/threads/env/thread");
    expect(clearLastResponse).toHaveBeenCalledOnce();

    routeAgentNotificationResponseOnce({ handledResponseIds, response, navigate });
    expect(navigate).toHaveBeenCalledTimes(2);
  });

  it("opens a cold Slack ask and its warm recorded answer, and rejects a revoked tap", async () => {
    const registry = AtomRegistry.make();
    try {
      const allowed = Atom.make(true);
      const originAddress = { kind: "slack" };
      const open = { originAddress, generation: 1, openQuestions: [{ questionId: "ask" }] };
      const answered = {
        ...open,
        openQuestions: [],
        answeredQuestions: [{ questionId: "ask", answerText: "Option A" }],
      };
      const run = vi
        .fn()
        .mockResolvedValueOnce(AsyncResult.success(open))
        .mockResolvedValueOnce(AsyncResult.success(answered))
        .mockImplementationOnce(async () => {
          registry.set(allowed, false);
          return AsyncResult.success(answered);
        })
        .mockResolvedValueOnce(AsyncResult.success({ ...answered, generation: 2 }));
      const channels = {
        listBotAttention: { permissionAtom: () => allowed },
        readAttentionTask: { run },
      } as unknown as Parameters<typeof resolveMobileBotAttentionLink>[1];
      const handledResponseIds = new Set<string>();
      const navigate = vi.fn();
      const data = {
        kind: "goat-bot-attention",
        environmentId: "env",
        botId: "main",
        taskId: "task",
        requestId: "ask",
        generation: 1,
      };
      const response = (id: string) => responseWithData(data, id) as NotificationResponse;
      const handle = (notification: NotificationResponse) =>
        routeAgentNotificationResponseOnce({
          handledResponseIds,
          response: notification,
          navigate,
          resolveBotTarget: (target) => resolveMobileBotAttentionLink(registry, channels, target),
        });
      await consumeLastAgentNotificationResponse({
        getLastResponse: () => Promise.resolve(response("cold")),
        clearLastResponse: () => Promise.resolve(),
        handleResponse: handle,
      });
      await handle(response("cold"));
      await handle(response("warm"));
      await handle(response("revoked"));
      registry.set(allowed, true);
      await handle(response("stale-generation"));

      const searches = navigate.mock.calls.map(([href]) =>
        Object.fromEntries(new URL(String(href), "https://app.test").searchParams),
      );
      const detail = { taskId: "task", attentionEnvironment: "env", attentionDetail: "external" };
      expect(searches).toEqual([
        { ...detail, attentionRequest: "ask" },
        { ...detail, attentionRequest: "ask" },
        detail,
      ]);
      expect(run).toHaveBeenCalledTimes(4);
      expect(run).toHaveBeenCalledWith(registry, {
        environmentId: "env",
        input: { taskId: "task", botId: "main", attentionRequest: "ask" },
      });
    } finally {
      registry.dispose();
    }
  });

  it("discards malformed destination ids without leaving the response pending", async () => {
    const response = responseWithData({
      environmentId: "env",
      threadId: "\ud800",
    }) as NotificationResponse;
    const handledResponseIds = new Set<string>();
    const navigate = vi.fn();
    const clearLastResponse = vi.fn(() => Promise.resolve());

    await consumeLastAgentNotificationResponse({
      getLastResponse: () => Promise.resolve(response),
      clearLastResponse,
      handleResponse: (response) =>
        routeAgentNotificationResponseOnce({ handledResponseIds, response, navigate }),
    });

    expect(navigate).not.toHaveBeenCalled();
    expect(clearLastResponse).toHaveBeenCalledOnce();
    expect(handledResponseIds.has("notification-1")).toBe(true);
  });

  it("does not navigate twice when the initial and listener responses refer to one notification", () => {
    const handledResponseIds = new Set<string>();
    const navigations: Array<string> = [];
    const response = responseWithData({
      environmentId: "env",
      threadId: "thread",
    });

    routeAgentNotificationResponseOnce({
      handledResponseIds,
      response,
      navigate: (deepLink) => navigations.push(deepLink),
    });
    routeAgentNotificationResponseOnce({
      handledResponseIds,
      response,
      navigate: (deepLink) => navigations.push(deepLink),
    });

    expect(navigations).toEqual(["/threads/env/thread"]);
  });
});
