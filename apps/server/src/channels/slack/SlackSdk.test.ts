// @effect-diagnostics nodeBuiltinImport:off - drives the real Slack SDK against local HTTP and TCP servers.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

import { SocketModeClient } from "@slack/socket-mode";
import {
  WebAPIHTTPError,
  WebAPIPlatformError,
  WebAPIRateLimitedError,
  WebAPIRequestError,
} from "@slack/web-api";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  bridgeSocketModeClient,
  classifySlackSdkError,
  isSlackSdkFailure,
  type SlackSocketEnvelope,
  type SlackSocketLifecycle,
} from "./SlackSdk.ts";

const APP_TOKEN = "xapp-1-SENTINEL-app-token";
const BOT_TOKEN = "xoxb-SENTINEL-bot-token";

const platformError = (error: string) =>
  new WebAPIPlatformError({ ok: false, error, response_metadata: { messages: [BOT_TOKEN] } });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("classifySlackSdkError", () => {
  it.each([
    [
      "rate limit",
      new WebAPIRateLimitedError(30),
      { category: "rate_limited", retryAfterSeconds: 30 },
    ],
    ["revoked token", platformError("token_revoked"), { category: "auth_revoked" }],
    ["inactive account", platformError("account_inactive"), { category: "auth_revoked" }],
    ["invalid token", platformError("invalid_auth"), { category: "auth_invalid" }],
    ["bot not in channel", platformError("not_in_channel"), { category: "not_in_channel" }],
    ["unknown channel", platformError("channel_not_found"), { category: "channel_not_found" }],
    ["other platform error", platformError("msg_too_long"), { category: "platform" }],
    [
      "request timeout",
      new WebAPIRequestError(Object.assign(new Error(BOT_TOKEN), { name: "TimeoutError" })),
      { category: "timeout" },
    ],
    [
      "network failure",
      new WebAPIRequestError(new Error(`connect failed ${BOT_TOKEN}`)),
      { category: "network" },
    ],
    [
      "HTTP failure",
      new WebAPIHTTPError(502, "Bad Gateway", { authorization: `Bearer ${BOT_TOKEN}` }, BOT_TOKEN),
      { category: "http", httpStatus: 502 },
    ],
    ["anything else", new Error(BOT_TOKEN), { category: "unknown" }],
  ])("maps a %s to a bounded category", (_label, error, expected) => {
    const failure = classifySlackSdkError("chat.postMessage", error);
    expect(failure).toMatchObject({
      _tag: "SlackSdkFailure",
      operation: "chat.postMessage",
      ...expected,
    });
  });

  it("never carries tokens, headers or payloads from the SDK error", () => {
    const failures = [
      platformError("token_revoked"),
      new WebAPIRequestError(new Error(BOT_TOKEN)),
      new WebAPIHTTPError(401, "Unauthorized", { authorization: `Bearer ${BOT_TOKEN}` }, BOT_TOKEN),
      new Error(BOT_TOKEN),
    ].map((error) => classifySlackSdkError("auth.test", error));
    for (const failure of failures) {
      expect(JSON.stringify(failure)).not.toContain("SENTINEL");
      expect(failure.message).not.toContain("SENTINEL");
      expect(Object.keys(failure)).not.toContain("cause");
    }
  });

  it("passes an already classified failure through", () => {
    const failure = classifySlackSdkError("auth.test", platformError("invalid_auth"));
    expect(classifySlackSdkError("chat.postMessage", failure)).toBe(failure);
  });
});

describe("bridgeSocketModeClient", () => {
  const makeClient = () =>
    new SocketModeClient({
      appToken: APP_TOKEN,
      autoReconnectEnabled: false,
      // Connection refused locally, so start() fails without reaching Slack.
      clientOptions: { slackApiUrl: "http://127.0.0.1:9/api/", retryConfig: { retries: 0 } },
    });

  it("delivers slack_event envelopes until the listener is removed", async () => {
    const client = makeClient();
    const session = bridgeSocketModeClient(client);
    const received: SlackSocketEnvelope[] = [];
    const remove = session.onEnvelope((envelope) => received.push(envelope));
    let acked = 0;
    const payload = {
      ack: async () => {
        acked += 1;
      },
      envelope_id: "env-1",
      type: "events_api",
      body: { type: "event_callback" },
      retry_num: 2,
      retry_reason: "timeout",
    };

    client.emit("slack_event", payload);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      envelopeId: "env-1",
      type: "events_api",
      body: { type: "event_callback" },
      retryNum: 2,
      retryReason: "timeout",
    });
    await received[0]!.ack();
    expect(acked).toBe(1);

    remove();
    client.emit("slack_event", payload);
    expect(received).toHaveLength(1);
  });

  it("reports connection lifecycle until the listener is removed", () => {
    const client = makeClient();
    const events: SlackSocketLifecycle[] = [];
    const remove = bridgeSocketModeClient(client).onLifecycle((event) => events.push(event));
    client.emit("connecting");
    client.emit("connected");
    client.emit("disconnected");
    remove();
    client.emit("connected");
    expect(events.map((event) => event._tag)).toEqual(["connecting", "connected", "disconnected"]);
  });

  it("rejects a failed start with a classified failure and no token", async () => {
    const consoleCalls = [
      vi.spyOn(console, "log"),
      vi.spyOn(console, "info"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "error"),
      vi.spyOn(console, "debug"),
    ];
    const session = bridgeSocketModeClient(makeClient());
    const failure: unknown = await session.start().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(isSlackSdkFailure(failure)).toBe(true);
    expect(failure).toMatchObject({ operation: "socket.start", category: "network" });
    expect(JSON.stringify(failure)).not.toContain("SENTINEL");
    await session.disconnect();
    // The bridge does not supply a logger here; the live layer does. Only check nothing
    // leaked the token through console output during the failed start.
    for (const call of consoleCalls) {
      expect(JSON.stringify(call.mock.calls)).not.toContain("SENTINEL");
    }
  });
});

describe("bridgeSocketModeClient retirement", () => {
  it("closes a socket that start() opens after the session was retired, without a hello", async () => {
    // A TCP server that accepts the WebSocket connection but never answers it, so the SDK
    // stays in its connecting state and start() would otherwise never settle.
    let markClosed!: () => void;
    const lateSocketClosed = new Promise<void>((resolve) => {
      markClosed = resolve;
    });
    let accepted = 0;
    const socketServer = NodeNet.createServer((socket) => {
      accepted += 1;
      socket.once("close", () => markClosed());
    });
    await new Promise<void>((resolve) => socketServer.listen(0, "127.0.0.1", resolve));
    const socketPort = (socketServer.address() as NodeNet.AddressInfo).port;

    // A Slack API whose apps.connections.open reply the test releases after retiring.
    let releaseUrl!: () => void;
    const urlReleased = new Promise<void>((resolve) => {
      releaseUrl = resolve;
    });
    let markRequested!: () => void;
    const urlRequested = new Promise<void>((resolve) => {
      markRequested = resolve;
    });
    const apiServer = NodeHttp.createServer((request, response) => {
      request.resume();
      markRequested();
      void urlReleased.then(() => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ ok: true, url: `ws://127.0.0.1:${socketPort}/` }));
      });
    });
    await new Promise<void>((resolve) => apiServer.listen(0, "127.0.0.1", resolve));
    const apiPort = (apiServer.address() as NodeNet.AddressInfo).port;

    try {
      const client = new SocketModeClient({
        appToken: APP_TOKEN,
        autoReconnectEnabled: false,
        clientOptions: {
          slackApiUrl: `http://127.0.0.1:${apiPort}/api/`,
          retryConfig: { retries: 0 },
        },
      });
      const session = bridgeSocketModeClient(client);
      const started = session.start().then(
        () => "resolved",
        () => "rejected",
      );
      await urlRequested;
      await session.disconnect();
      releaseUrl();

      // The SDK opens its socket late; the bridge closes it again without a hello.
      await lateSocketClosed;
      expect(accepted).toBe(1);
      expect(await started).toBe("rejected");
    } finally {
      await new Promise<void>((resolve) => apiServer.close(() => resolve()));
      await new Promise<void>((resolve) => socketServer.close(() => resolve()));
    }
  });
});
