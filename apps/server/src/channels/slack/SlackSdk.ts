/**
 * Boundary around the official Slack SDKs. Everything Slack-specific that talks to the
 * network goes through these ports so the channel adapter and its tests never touch
 * `@slack/socket-mode` or `@slack/web-api` directly.
 *
 * Raw SDK errors are reduced to {@link SlackSdkFailure} at this boundary and then
 * dropped: their `data`, `headers` and messages can carry tokens or event payloads.
 *
 * @module SlackSdk
 */
import * as NodeModule from "node:module";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { LogLevel, type Logger, SocketModeClient } from "@slack/socket-mode";

import type { SlackChoiceBlock } from "./slackMessageFormatting.ts";
import {
  WebAPIHTTPError,
  WebAPIPlatformError,
  WebAPIRateLimitedError,
  WebAPIRequestError,
  WebClient,
  type FetchFunction,
  type WebClientOptions,
} from "@slack/web-api";

// undici stays external to the CLI bundle (Cursor's runtime closure needs it on
// disk), and a Node single-executable can only `import` built-ins, so load it
// through require the first time Slack makes a request.
const requireForUndici = NodeModule.createRequire(import.meta.url);
const undiciFetch: typeof import("undici").fetch = (input, init) =>
  (requireForUndici("undici") as typeof import("undici")).fetch(input, init);

/** One Socket Mode envelope. `ack` tells Slack the event was received; call it once. */
export interface SlackSocketEnvelope {
  readonly envelopeId: string;
  /** Envelope type, `events_api` for Events API payloads. */
  readonly type: string;
  /** The Events API payload (`event_callback`). Untrusted. */
  readonly body: unknown;
  readonly retryNum: number | undefined;
  readonly retryReason: string | undefined;
  readonly ack: () => Promise<void>;
}

export type SlackSocketLifecycle =
  | { readonly _tag: "connecting" }
  | { readonly _tag: "connected" }
  | { readonly _tag: "disconnected" };

export interface SlackSocketSession {
  /** Opens the socket. Rejects with {@link SlackSdkFailure}. */
  readonly start: () => Promise<void>;
  readonly disconnect: () => Promise<void>;
  /** Returns a function that removes the listener. */
  readonly onEnvelope: (listener: (envelope: SlackSocketEnvelope) => void) => () => void;
  readonly onLifecycle: (listener: (event: SlackSocketLifecycle) => void) => () => void;
}

export interface SlackAuthIdentity {
  readonly teamId: string;
  readonly botUserId: string;
  readonly botId: string | undefined;
}

/** Web API calls made with the bot token (`xoxb-`). */
export interface SlackBotApi {
  readonly authTest: () => Promise<SlackAuthIdentity>;
  readonly postMessage: (input: {
    readonly channel: string;
    readonly threadTs: string;
    readonly text: string;
    /** Block Kit for choice buttons. Absent when the message has no options. */
    readonly blocks?: ReadonlyArray<SlackChoiceBlock> | undefined;
  }) => Promise<{ readonly ts: string }>;
}

/** Web API calls made with the app-level token (`xapp-`). Used to validate it. */
export interface SlackAppApi {
  /** Calls `apps.connections.open` and discards the returned socket URL. */
  readonly openConnection: () => Promise<void>;
}

const SlackSdkOperation = Schema.Literals([
  "auth.test",
  "apps.connections.open",
  "chat.postMessage",
  "socket.start",
  "socket.disconnect",
]);
export type SlackSdkOperation = typeof SlackSdkOperation.Type;

const SlackSdkFailureCategory = Schema.Literals([
  "rate_limited",
  "auth_revoked",
  "auth_invalid",
  "not_in_channel",
  "channel_not_found",
  "platform",
  "network",
  "timeout",
  "http",
  /** The call returned without the receipt it should carry; it may still have taken effect. */
  "unconfirmed",
  "unknown",
]);
export type SlackSdkFailureCategory = typeof SlackSdkFailureCategory.Type;

export class SlackSdkFailure extends Schema.TaggedError<SlackSdkFailure>()("SlackSdkFailure", {
  operation: SlackSdkOperation,
  category: SlackSdkFailureCategory,
  retryAfterSeconds: Schema.optionalKey(Schema.Number),
  httpStatus: Schema.optionalKey(Schema.Number),
}) {
  override get message(): string {
    return `Slack ${this.operation} failed: ${this.category}.`;
  }
}
export const isSlackSdkFailure = Schema.is(SlackSdkFailure);

const REVOKED_PLATFORM_ERRORS = new Set([
  "token_revoked",
  "token_expired",
  "account_inactive",
  "team_disabled",
  "user_removed_from_team",
]);
const INVALID_PLATFORM_ERRORS = new Set([
  "invalid_auth",
  "not_authed",
  "not_allowed_token_type",
  "missing_scope",
]);

/** Reduces any SDK error to a bounded category. The original error is not kept. */
export function classifySlackSdkError(
  operation: SlackSdkOperation,
  error: unknown,
): SlackSdkFailure {
  if (isSlackSdkFailure(error)) return error;
  if (error instanceof WebAPIRateLimitedError) {
    return new SlackSdkFailure({
      operation,
      category: "rate_limited",
      retryAfterSeconds: error.retryAfter,
    });
  }
  if (error instanceof WebAPIPlatformError) {
    const code = error.data.error;
    const category: SlackSdkFailureCategory = REVOKED_PLATFORM_ERRORS.has(code)
      ? "auth_revoked"
      : INVALID_PLATFORM_ERRORS.has(code)
        ? "auth_invalid"
        : code === "not_in_channel"
          ? "not_in_channel"
          : code === "channel_not_found"
            ? "channel_not_found"
            : "platform";
    return new SlackSdkFailure({ operation, category });
  }
  if (error instanceof WebAPIRequestError) {
    return new SlackSdkFailure({
      operation,
      category: error.original?.name === "TimeoutError" ? "timeout" : "network",
    });
  }
  if (error instanceof WebAPIHTTPError) {
    return new SlackSdkFailure({ operation, category: "http", httpStatus: error.statusCode });
  }
  return new SlackSdkFailure({ operation, category: "unknown" });
}

/** Runs one SDK call as an Effect that fails only with {@link SlackSdkFailure}. */
export const slackCall = <A>(
  operation: SlackSdkOperation,
  call: () => Promise<A>,
): Effect.Effect<A, SlackSdkFailure> =>
  Effect.tryPromise({ try: call, catch: (error) => classifySlackSdkError(operation, error) });

const ignore = () => {};
/** The SDKs log raw payloads and request failures at debug/error; none of it may reach our logs. */
const silentSlackLogger: Logger = {
  debug: ignore,
  info: ignore,
  warn: ignore,
  error: ignore,
  setLevel: ignore,
  getLevel: () => LogLevel.ERROR,
  setName: ignore,
};

// The outbox owns retries and their timing, so the SDK must fail fast: no hidden
// 30-minute retry policy, no queued rate-limit waits, and a bounded request time.
const slackWebClientOptions = {
  logger: silentSlackLogger,
  rejectRateLimitedCalls: true,
  retryConfig: { retries: 0 },
  timeout: 10_000,
  // Same fetch the socket client uses; undici types its Response apart from lib.dom.
  fetch: undiciFetch as unknown as FetchFunction,
} satisfies WebClientOptions;

const rejectWith =
  (operation: SlackSdkOperation) =>
  (error: unknown): never => {
    throw classifySlackSdkError(operation, error);
  };

interface SlackEventPayload {
  readonly ack: () => Promise<void>;
  readonly envelope_id: string;
  readonly type: string;
  readonly body: unknown;
  readonly retry_num?: number;
  readonly retry_reason?: string;
}

/**
 * Adapts a SocketModeClient to {@link SlackSocketSession}. A session is single use: once
 * disconnected it stays retired, including a socket that `start()` creates afterwards.
 */
export function bridgeSocketModeClient(client: SocketModeClient): SlackSocketSession {
  let retired = false;
  const closeQuietly = () => client.disconnect().catch(() => undefined);
  // start() opens its socket only after fetching the URL, and emits `connecting` right before
  // connecting it. A session retired while the URL was in flight closes that socket here, after
  // the synchronous connect call, without waiting for a hello that may never arrive. This
  // listener stays for the client's lifetime, independent of the caller's listeners.
  client.on("connecting", () => {
    if (retired) queueMicrotask(() => void closeQuietly());
  });
  return {
    start: () =>
      client.start().then(() => {
        if (retired) {
          void closeQuietly();
          throw new SlackSdkFailure({ operation: "socket.start", category: "network" });
        }
      }, rejectWith("socket.start")),
    disconnect: () => {
      retired = true;
      return client.disconnect().catch(rejectWith("socket.disconnect"));
    },
    onEnvelope: (listener) => {
      const handler = (payload: SlackEventPayload) =>
        listener({
          envelopeId: payload.envelope_id,
          type: payload.type,
          body: payload.body,
          retryNum: payload.retry_num,
          retryReason: payload.retry_reason,
          ack: () => payload.ack(),
        });
      client.on("slack_event", handler);
      return () => {
        client.off("slack_event", handler);
      };
    },
    onLifecycle: (listener) => {
      const connecting = () => listener({ _tag: "connecting" });
      const connected = () => listener({ _tag: "connected" });
      const disconnected = () => listener({ _tag: "disconnected" });
      client.on("connecting", connecting);
      client.on("connected", connected);
      client.on("disconnected", disconnected);
      return () => {
        client.off("connecting", connecting);
        client.off("connected", connected);
        client.off("disconnected", disconnected);
      };
    },
  };
}

const openSession = (appToken: string): SlackSocketSession =>
  bridgeSocketModeClient(
    new SocketModeClient({
      appToken,
      logger: silentSlackLogger,
      // The SDK's own reconnect drops a rejected retry on the floor; the runtime reconnects instead.
      autoReconnectEnabled: false,
      clientOptions: {
        rejectRateLimitedCalls: slackWebClientOptions.rejectRateLimitedCalls,
        retryConfig: slackWebClientOptions.retryConfig,
        timeout: slackWebClientOptions.timeout,
        fetch: slackWebClientOptions.fetch,
      },
    }),
  );

const nonEmpty = (value: string | undefined): value is string =>
  typeof value === "string" && value.length > 0;

const botApi = ({ botToken }: { readonly botToken: string }): SlackBotApi => {
  const client = new WebClient(botToken, slackWebClientOptions);
  return {
    authTest: () =>
      client.auth.test().then((response) => {
        if (!nonEmpty(response.team_id) || !nonEmpty(response.user_id)) {
          throw new SlackSdkFailure({ operation: "auth.test", category: "platform" });
        }
        return {
          teamId: response.team_id,
          botUserId: response.user_id,
          botId: nonEmpty(response.bot_id) ? response.bot_id : undefined,
        };
      }, rejectWith("auth.test")),
    postMessage: ({ channel, threadTs, text, blocks }) => {
      const message = {
        channel,
        thread_ts: threadTs,
        text,
        unfurl_links: false,
        unfurl_media: false,
        // The port's blocks are the buttons this adapter builds; the Web API accepts them.
        ...(blocks === undefined || blocks.length === 0 ? {} : { blocks: blocks as never }),
      };
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Slack's chat.postMessage, not window.postMessage.
      return client.chat.postMessage(message).then((response) => {
        if (!nonEmpty(response.ts)) {
          throw new SlackSdkFailure({ operation: "chat.postMessage", category: "unconfirmed" });
        }
        return { ts: response.ts };
      }, rejectWith("chat.postMessage"));
    },
  };
};

const appApi = ({ appToken }: { readonly appToken: string }): SlackAppApi => {
  const client = new WebClient(appToken, slackWebClientOptions);
  return {
    openConnection: () =>
      client.apps.connections.open({}).then(() => undefined, rejectWith("apps.connections.open")),
  };
};

/** Creates Slack clients. Constructors do no I/O; calls on the returned ports do. */
export class SlackSdk extends Context.Service<
  SlackSdk,
  {
    readonly openSession: (appToken: string) => SlackSocketSession;
    readonly botApi: (input: { readonly botToken: string }) => SlackBotApi;
    readonly appApi: (input: { readonly appToken: string }) => SlackAppApi;
  }
>()("goat/channels/slack/SlackSdk") {}

export const layer = Layer.succeed(SlackSdk, SlackSdk.of({ openSession, botApi, appApi }));
