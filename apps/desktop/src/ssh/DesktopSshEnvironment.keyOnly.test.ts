import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NetService from "@goat/shared/Net";
import * as SshTunnel from "@goat/ssh/tunnel";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";
import * as DesktopSshEnvironment from "./DesktopSshEnvironment.ts";
import * as DesktopSshPasswordPrompts from "./DesktopSshPasswordPrompts.ts";
vi.mock("electron", () => ({}));

describe("sshEnvironment", () => {
  it.effect("passes key-only provisioning to the SSH manager without requesting a password", () => {
    const target = { alias: "devbox", hostname: "box.example.test", username: null, port: null };
    return Effect.gen(function* () {
      const environment = yield* DesktopSshEnvironment.make;
      const result = yield* environment.ensureEnvironment(target, {
        keyOnly: true,
        issuePairingToken: true,
      });
      if ("type" in result) throw new Error("unexpected pending runtime replacement");
      assert.equal(result.pairingToken, "fixture-token");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          NodeHttpClient.layerUndici,
          NetService.layer,
          Layer.succeed(DesktopSshPasswordPrompts.DesktopSshPasswordPrompts, {
            request: () => Effect.die("unexpected password prompt"),
            resolve: () => Effect.die("unused"),
          }),
          Layer.succeed(SshTunnel.SshEnvironmentManager, {
            status: () => Effect.die("unused"),
            ensureEnvironment: (receivedTarget, options) =>
              Effect.sync(() => {
                assert.deepEqual(receivedTarget, target);
                assert.deepEqual(options, { keyOnly: true, issuePairingToken: true });
                return {
                  target,
                  httpBaseUrl: "http://127.0.0.1:41773/",
                  wsBaseUrl: "ws://127.0.0.1:41773/",
                  pairingToken: "fixture-token",
                };
              }),
            readyEnvironment: () => Effect.die("Unexpected ready environment"),
            beginSetupOperation: () => Effect.die("Unexpected setup operation"),
            publishProviderDiagnosis: () => Effect.die("Unexpected provider publication"),
            publishSetupOutcome: () => Effect.die("Unexpected setup outcome"),
            forgetEnvironment: () => Effect.die("Unexpected forget"),
            disconnectEnvironment: () => Effect.die("unused"),
            revalidateTunnels: () => Effect.die("unused"),
            closeAllTunnels: Effect.die("unused"),
            issueMcpClientSession: () => Effect.die("unused"),
            issueClientSession: () => Effect.die("unexpected client session"),
            runRemoteScript: () => Effect.die("unused"),
          }),
        ),
      ),
    );
  });
});
