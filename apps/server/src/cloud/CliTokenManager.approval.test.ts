// @effect-diagnostics nodeBuiltinImport:off - The fixture holds a real TCP port.
import * as NodeNet from "node:net";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Terminal from "effect/Terminal";
import { FetchHttpClient, HttpClient, HttpClientResponse, HttpClientRequest } from "effect/http";
import { readConnectAuthorizeRequest } from "@goat/shared/connectAuth";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ExternalLauncher from "../process/externalLauncher.ts";
import * as CliTokenManager from "./CliTokenManager.ts";

const env = {
  GOAT_HOSTED_APP_URL: "https://app.trygoat.ai",
  GOAT_CLERK_PUBLISHABLE_KEY: `pk_test_${btoa("clerk.example.test$")}`,
  GOAT_CLERK_CLI_OAUTH_CLIENT_ID: "cli-client",
};
const intent = {
  connectAuthPolicyVersion: 1 as const,
  environmentId: "environment-1",
  environmentPublicKey: "host-key",
  origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
  notificationsEnabled: false as const,
  liveActivitiesEnabled: false as const,
  managedTunnelsEnabled: true,
};
// On Linux any outgoing socket can take the registered callback port, so the flow must not need it free.
const holdRegisteredCallbackPort = Effect.acquireRelease(
  Effect.callback<NodeNet.Server>((resume) => {
    const server = NodeNet.createServer();
    server.once("error", () => resume(Effect.succeed(server)));
    server.listen(34338, "127.0.0.1", () => resume(Effect.succeed(server)));
  }),
  (server) =>
    Effect.callback<void>((resume) => {
      if (server.listening) server.close(() => resume(Effect.void));
      else resume(Effect.void);
    }),
);

describe("CLI approval and OAuth callback join", () => {
  it.live.each(["code-first", "approval-first"] as const)(
    "does not complete from one callback alone (%s)",
    (order) =>
      Effect.gen(function* () {
        yield* holdRegisteredCallbackPort;
        const input = yield* Queue.unbounded<Terminal.UserInput, Cause.Done>();
        const callbackClient = yield* HttpClient.HttpClient;
        const launched = yield* Deferred.make<string>();
        let exchanges = 0;
        const http = HttpClient.make((request) =>
          Effect.sync(() => {
            exchanges += 1;
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                access_token: "oauth-access",
                refresh_token: "oauth-refresh",
                expires_in: 3600,
                token_type: "bearer",
              }),
            );
          }),
        );
        const flowLayer = CliTokenManager.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(ServerSecretStore.ServerSecretStore, {
                get: () => Effect.succeedNone,
                set: () => Effect.void,
              }),
              Layer.mock(ExternalLauncher.ExternalLauncher, {
                launchBrowser: (url) => Deferred.succeed(launched, url).pipe(Effect.asVoid),
              }),
              Layer.succeed(
                Terminal.Terminal,
                Terminal.make({
                  columns: Effect.succeed(80),
                  rows: Effect.succeed(24),
                  readInput: Effect.succeed(input),
                  readLine: Effect.die("unused"),
                  display: () => Effect.void,
                }),
              ),
              Layer.succeed(HttpClient.HttpClient, http),
            ),
          ),
        );
        const flow = CliTokenManager.CloudCliTokenManager.pipe(
          Effect.flatMap((manager) => manager.approveLink(intent)),
          Effect.provide(flowLayer),
          Effect.provideService(CliTokenManager.CliOAuthLoopbackPort, 0),
        );
        const fiber = yield* flow.pipe(Effect.forkChild);
        yield* Queue.offer(input, {
          input: Option.none(),
          key: { name: "enter", ctrl: false, meta: false, shift: false },
        });
        const authorizeUrl = yield* Deferred.await(launched);
        const request = readConnectAuthorizeRequest(new URL(authorizeUrl));
        if (!request?.approval) throw new Error("Missing approval intent");
        const base = `http://127.0.0.1:${request.loopbackPort}`;
        const expiresAt = DateTime.formatIso(DateTime.add(yield* DateTime.now, { seconds: 120 }));
        const code = () =>
          callbackClient.get(`${base}/callback?state=${request.state}&code=code-1`);
        const approval = (origin = env.GOAT_HOSTED_APP_URL) =>
          HttpClientRequest.post(`${base}/approval`).pipe(
            HttpClientRequest.setHeader("origin", origin),
            HttpClientRequest.bodyText(
              JSON.stringify({ state: request.state, approval: "signed-approval", expiresAt }),
            ),
            callbackClient.execute,
          );
        expect((yield* approval("https://staging.app.trygoat.ai")).status).toBe(403);
        expect((yield* order === "code-first" ? code() : approval()).status).toBe(200);
        expect(exchanges).toBe(0);
        expect((yield* order === "code-first" ? code() : approval()).status).toBe(400);
        expect((yield* order === "code-first" ? approval() : code()).status).toBe(200);
        const result = yield* Fiber.join(fiber);
        expect(result.approval).toBe("signed-approval");
        expect(result.approvalState).toBe(request.state);
        expect(result.key.thumbprint).toBe(request.approval.cliKeyThumbprint);
        expect(result.token.accessToken).toBe("oauth-access");
        expect(exchanges).toBe(1);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
            NodeServices.layer,
            FetchHttpClient.layer,
          ),
        ),
        Effect.scoped,
      ),
  );
});

it.live("ordinary CLI login obtains only withdrawal identity without minting a link approval", () =>
  Effect.gen(function* () {
    yield* holdRegisteredCallbackPort;
    const input = yield* Queue.unbounded<Terminal.UserInput, Cause.Done>();
    const launched = yield* Deferred.make<string>();
    let stored = 0;
    const requests: string[] = [];
    const flowLayer = CliTokenManager.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ServerSecretStore.ServerSecretStore, {
            get: () => Effect.succeedNone,
            set: () =>
              Effect.sync(() => {
                stored++;
              }),
          }),
          Layer.mock(ExternalLauncher.ExternalLauncher, {
            launchBrowser: (url) => Deferred.succeed(launched, url).pipe(Effect.asVoid),
          }),
          Layer.succeed(
            Terminal.Terminal,
            Terminal.make({
              columns: Effect.succeed(80),
              rows: Effect.succeed(24),
              readInput: Effect.succeed(input),
              readLine: Effect.die("unused"),
              display: () => Effect.void,
            }),
          ),
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.sync(() => {
                requests.push(new URL(request.url).pathname);
                return HttpClientResponse.fromWeb(
                  request,
                  Response.json({
                    access_token: "withdrawal-oauth",
                    refresh_token: "withdrawal-refresh",
                    expires_in: 3600,
                    token_type: "bearer",
                  }),
                );
              }),
            ),
          ),
        ),
      ),
    );
    const fiber = yield* CliTokenManager.CloudCliTokenManager.pipe(
      Effect.flatMap((manager) => manager.get),
      Effect.provide(flowLayer),
      Effect.provideService(CliTokenManager.CliOAuthLoopbackPort, 0),
      Effect.forkChild,
    );
    yield* Queue.offer(input, {
      input: Option.none(),
      key: { name: "enter", ctrl: false, meta: false, shift: false },
    });
    const authorize = new URL(yield* Deferred.await(launched));
    expect(authorize.pathname).toBe("/oauth/authorize");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    const callback = new URL(authorize.searchParams.get("redirect_uri") ?? "");
    callback.searchParams.set("state", authorize.searchParams.get("state") ?? "");
    callback.searchParams.set("code", "withdrawal-code");
    expect((yield* (yield* HttpClient.HttpClient).get(callback.toString())).status).toBe(200);
    const result = yield* Fiber.join(fiber);
    expect(result._tag).toBe("Authorized");
    expect("approval" in result).toBe(false);
    expect(requests).toEqual(["/oauth/token"]);
    expect(stored).toBe(1);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
        NodeServices.layer,
        FetchHttpClient.layer,
      ),
    ),
    Effect.scoped,
  ),
);
