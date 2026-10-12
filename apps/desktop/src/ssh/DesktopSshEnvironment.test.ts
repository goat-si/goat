import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NetService from "@goat/shared/Net";
import * as SshTunnel from "@goat/ssh/tunnel";
import { SshPasswordPromptError } from "@goat/ssh/errors";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as DesktopSshEnvironment from "./DesktopSshEnvironment.ts";
import * as DesktopSshPasswordPrompts from "./DesktopSshPasswordPrompts.ts";

function makeTempHomeDir() {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.makeTempDirectoryScoped({ prefix: "goat-ssh-env-test-" });
  });
}

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
          NodeHttpClient.layerUndici,
          NetService.layer,
          Layer.succeed(DesktopSshPasswordPrompts.DesktopSshPasswordPrompts, {
            request: () => Effect.die("unexpected password prompt"),
            resolve: () => Effect.die("unused"),
          }),
          Layer.succeed(SshTunnel.SshEnvironmentManager, {
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
            disconnectEnvironment: () => Effect.die("unused"),
            revalidateTunnels: () => Effect.die("unused"),
            issueMcpClientSession: () => Effect.die("unused"),
            runRemoteScript: () => Effect.die("unused"),
          }),
        ),
      ),
    );
  });
  it("keeps prompt presentation diagnostics distinct from the legacy wrapper message", () => {
    const cause = new DesktopSshPasswordPrompts.DesktopSshPromptPresentationError({
      requestId: "prompt-1",
      destination: "devbox",
      operation: "send-prompt-request",
      cause: new Error("renderer send failed"),
    });

    assert.equal(cause.message, "Failed to present SSH password prompt for devbox.");
    assert.equal(
      DesktopSshEnvironment.toSshPasswordPromptError(cause).message,
      "GOAT window is not available for SSH authentication.",
    );
  });

  it("treats password prompt timeouts as cancellable authentication prompts", () => {
    assert.equal(
      DesktopSshEnvironment.isDesktopSshPasswordPromptCancellation(
        new SshPasswordPromptError({
          message: "SSH authentication timed out for devbox.",
          cause: new DesktopSshPasswordPrompts.DesktopSshPromptTimedOutError({
            requestId: "prompt-1",
            destination: "devbox",
          }),
        }),
      ),
      true,
    );
  });

  it.effect("wires desktop host discovery through the ssh package runtime", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homeDir = yield* makeTempHomeDir();
      const sshDir = path.join(homeDir, ".ssh");
      yield* fs.makeDirectory(path.join(sshDir, "config.d"), { recursive: true });
      yield* fs.writeFileString(
        path.join(sshDir, "config"),
        ["Host devbox", "  HostName devbox.example.com", "Include config.d/*.conf", ""].join("\n"),
      );
      yield* fs.writeFileString(
        path.join(sshDir, "config.d", "team.conf"),
        [
          "Host staging",
          "  HostName staging.example.com",
          "Host *",
          "  ServerAliveInterval 30",
          "",
        ].join("\n"),
      );
      yield* fs.writeFileString(
        path.join(sshDir, "known_hosts"),
        [
          "known.example.com ssh-ed25519 AAAA",
          "|1|hashed|entry ssh-ed25519 AAAA",
          "[bastion.example.com]:2222 ssh-ed25519 AAAA",
          "",
        ].join("\n"),
      );

      const sshEnvironment = yield* DesktopSshEnvironment.DesktopSshEnvironment;
      const hosts = yield* sshEnvironment.discoverHosts({ homeDir });
      assert.deepEqual(hosts, [
        {
          alias: "bastion.example.com",
          hostname: "bastion.example.com",
          username: null,
          port: null,
          source: "known-hosts",
        },
        {
          alias: "devbox",
          hostname: "devbox",
          username: null,
          port: null,
          source: "ssh-config",
        },
        {
          alias: "known.example.com",
          hostname: "known.example.com",
          username: null,
          port: null,
          source: "known-hosts",
        },
        {
          alias: "staging",
          hostname: "staging",
          username: null,
          port: null,
          source: "ssh-config",
        },
      ]);
    }).pipe(
      Effect.provide(
        DesktopSshEnvironment.layer().pipe(
          Layer.provideMerge(
            Layer.succeed(DesktopSshPasswordPrompts.DesktopSshPasswordPrompts, {
              request: () => Effect.die("unexpected password prompt request"),
              resolve: () => Effect.die("unexpected password prompt resolution"),
            }),
          ),
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(NodeHttpClient.layerUndici),
          Layer.provideMerge(NetService.layer),
        ),
      ),
      Effect.scoped,
    ),
  );
});
