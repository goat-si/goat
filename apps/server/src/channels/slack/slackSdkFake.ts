/**
 * In-memory Slack SDK for tests. Sessions record every call in order, envelopes report
 * whether they were acknowledged, and each Web API call can be scripted per test.
 */
import * as Layer from "effect/Layer";

import {
  SlackSdk,
  SlackSdkFailure,
  type SlackAuthIdentity,
  type SlackBotApi,
  type SlackSocketEnvelope,
  type SlackSocketLifecycle,
  type SlackSocketSession,
} from "./SlackSdk.ts";

export interface FakeEnvelope {
  /** Resolves once the envelope is acknowledged. */
  readonly acked: Promise<void>;
  readonly ackCount: () => number;
}

export interface FakeSlackSession extends SlackSocketSession {
  readonly index: number;
  readonly appToken: string;
  readonly emitEnvelope: (
    body: unknown,
    options?: {
      readonly type?: string;
      /** Replaces the acknowledgement, e.g. to hold or lose it. */
      readonly ack?: () => Promise<void>;
    },
  ) => FakeEnvelope;
  readonly emitLifecycle: (tag: SlackSocketLifecycle["_tag"]) => void;
  readonly listenerCount: () => number;
}

interface PendingStart {
  readonly resolve: () => void;
  readonly reject: (failure: SlackSdkFailure) => void;
}

export function makeFakeSlackSdk() {
  /** Ordered record such as `open:0`, `start:0`, `disconnect:0`, `authTest`, `post`. */
  const calls: string[] = [];
  const callWaiters: Array<{ readonly call: string; readonly resolve: () => void }> = [];
  const record = (call: string) => {
    calls.push(call);
    for (const waiter of callWaiters.filter((w) => w.call === call)) waiter.resolve();
  };
  /** Resolves once a call has been recorded, immediately if it already was. */
  const waitForCall = (call: string) =>
    calls.includes(call)
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          callWaiters.push({ call, resolve });
        });
  const sessions: FakeSlackSession[] = [];
  const posted: Array<Parameters<SlackBotApi["postMessage"]>[0]> = [];
  const pendingStarts: PendingStart[] = [];
  let disconnectGate: Promise<void> | undefined;
  const script = {
    authTest: (): Promise<SlackAuthIdentity> =>
      Promise.resolve({ teamId: "T0TEAM", botUserId: "U0BOT", botId: "B0BOT" }),
    postMessage: (_input: Parameters<SlackBotApi["postMessage"]>[0]) =>
      Promise.resolve({ ts: "1760000001.000100" }),
    openConnection: () => Promise.resolve(),
    /** Default: the socket connects as soon as it starts. */
    start: (_session: FakeSlackSession): Promise<void> => Promise.resolve(),
  };

  const openSession = (appToken: string): FakeSlackSession => {
    const index = sessions.length;
    record(`open:${index}`);
    const envelopeListeners = new Set<(envelope: SlackSocketEnvelope) => void>();
    const lifecycleListeners = new Set<(event: SlackSocketLifecycle) => void>();
    let envelopeCount = 0;
    const session: FakeSlackSession = {
      index,
      appToken,
      start: () => {
        record(`start:${index}`);
        return script.start(session);
      },
      disconnect: () => {
        record(`disconnect:${index}`);
        return disconnectGate ?? Promise.resolve();
      },
      onEnvelope: (listener) => {
        envelopeListeners.add(listener);
        return () => envelopeListeners.delete(listener);
      },
      onLifecycle: (listener) => {
        lifecycleListeners.add(listener);
        return () => lifecycleListeners.delete(listener);
      },
      emitEnvelope: (body, options) => {
        let count = 0;
        let resolveAcked!: () => void;
        const acked = new Promise<void>((resolve) => {
          resolveAcked = resolve;
        });
        envelopeCount += 1;
        const envelope: SlackSocketEnvelope = {
          envelopeId: `env-${index}-${envelopeCount}`,
          type: options?.type ?? "events_api",
          body,
          retryNum: undefined,
          retryReason: undefined,
          ack: () => {
            count += 1;
            resolveAcked();
            return options?.ack?.() ?? Promise.resolve();
          },
        };
        for (const listener of envelopeListeners) listener(envelope);
        return { acked, ackCount: () => count };
      },
      emitLifecycle: (tag) => {
        for (const listener of lifecycleListeners) listener({ _tag: tag });
      },
      listenerCount: () => envelopeListeners.size + lifecycleListeners.size,
    };
    sessions.push(session);
    return session;
  };

  const layer = Layer.succeed(
    SlackSdk,
    SlackSdk.of({
      openSession,
      botApi: () => ({
        authTest: () => {
          record("authTest");
          return script.authTest();
        },
        postMessage: (input) => {
          record("post");
          posted.push({ ...input });
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- the fake Slack chat.postMessage, not window.postMessage.
          return script.postMessage({ ...input });
        },
      }),
      appApi: () => ({
        openConnection: () => {
          record("openConnection");
          return script.openConnection();
        },
      }),
    }),
  );

  return {
    layer,
    calls,
    waitForCall,
    sessions,
    posted,
    script,
    /** Makes the next starts wait until the test settles them. */
    holdStarts: () => {
      script.start = () =>
        new Promise<void>((resolve, reject) => {
          pendingStarts.push({ resolve, reject });
        });
    },
    pendingStarts,
    /** Makes disconnects wait until the returned function is called. */
    holdDisconnects: () => {
      let release!: () => void;
      disconnectGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        disconnectGate = undefined;
        release();
      };
    },
    failure: (
      operation: SlackSdkFailure["operation"],
      category: SlackSdkFailure["category"],
      retryAfterSeconds?: number,
    ) =>
      new SlackSdkFailure({
        operation,
        category,
        ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      }),
  };
}

export type FakeSlackSdk = ReturnType<typeof makeFakeSlackSdk>;
