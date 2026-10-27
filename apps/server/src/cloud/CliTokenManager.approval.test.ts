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
  GOAT_HOSTED_APP_URL: "https://app.example.test",
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

describe("CLI approval and OAuth callback join", () => {
  it.live.each(["code-first", "approval-first"] as const)(
    "does not complete from one callback alone (%s)",
    (order) =>
      Effect.gen(function* () {
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
        expect((yield* approval("https://staging.app.example.test")).status).toBe(403);
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
