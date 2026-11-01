import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { DesktopSshEnvironmentEnsureResultSchema } from "@goat/contracts";
import * as NetService from "@goat/shared/Net";
import * as SshTunnel from "@goat/ssh/tunnel";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/http";
import * as DesktopSshEnvironment from "./DesktopSshEnvironment.ts";
import * as DesktopSshPasswordPrompts from "./DesktopSshPasswordPrompts.ts";

// The service test provides every Electron-facing dependency.
vi.mock("electron", () => ({}));

const target = { alias: "box", hostname: "box.test", username: null, port: null };
const pending = {
  type: "ssh-runtime-pending",
  target,
  pending: {
    reason: "unknown",
    replacement: "incompatible",
    requestedVersion: "1.2.3",
    liveVersion: "1.2.2",
  },
} as const;
describe("desktop SSH pending result", () => {
  it("round trips the stranded recovery lock detail", () => {
    const schema = Schema.fromJsonString(DesktopSshEnvironmentEnsureResultSchema);
    const recovery = {
      ...pending,
      pending: {
        ...pending.pending,
        reason: "contended" as const,
        detail: "recovery-stale" as const,
      },
    };
    assert.deepEqual(Schema.decodeSync(schema)(Schema.encodeSync(schema)(recovery)), recovery);
  });
  it("round trips pending without inventing a port and preserves password cancellation", () => {
    const schema = Schema.fromJsonString(DesktopSshEnvironmentEnsureResultSchema);
    const encoded = Schema.encodeSync(schema)(pending);
    assert.deepEqual(Schema.decodeSync(schema)(encoded), pending);
    const cancelled = { type: "ssh-password-prompt-cancelled", message: "cancelled" } as const;
    assert.deepEqual(Schema.decodeSync(schema)(Schema.encodeSync(schema)(cancelled)), cancelled);
  });
  it.effect("service passes pending through without requesting a password", () =>
    Effect.gen(function* () {
      const service = yield* DesktopSshEnvironment.DesktopSshEnvironment;
      assert.deepEqual(
        yield* service.ensureEnvironment(target, { issuePairingToken: true }),
        pending,
      );
    }).pipe(
      Effect.provide(
        Layer.effect(DesktopSshEnvironment.DesktopSshEnvironment, DesktopSshEnvironment.make).pipe(
          Layer.provide(
            Layer.succeed(SshTunnel.SshEnvironmentManager, {
              status: () => Effect.die("Unexpected status"),
              ensureEnvironment: () => Effect.succeed(pending),
              readyEnvironment: () => Effect.die("Unexpected ready environment"),
              beginSetupOperation: () => Effect.die("Unexpected setup operation"),
              publishProviderDiagnosis: () => Effect.die("Unexpected provider publication"),
              publishSetupOutcome: () => Effect.die("Unexpected setup outcome"),
              forgetEnvironment: () => Effect.die("Unexpected forget"),
              disconnectEnvironment: () => Effect.void,
              revalidateTunnels: () => Effect.void,
              issueMcpClientSession: () => Effect.die("Unexpected session"),
              issueClientSession: () => Effect.die("unexpected client session"),
              runRemoteScript: () => Effect.die("Unexpected script"),
            }),
          ),
          Layer.provide(
            Layer.succeed(DesktopSshPasswordPrompts.DesktopSshPasswordPrompts, {
              request: () => Effect.die("Unexpected password prompt"),
              resolve: () => Effect.die("Unexpected resolution"),
            }),
          ),
          Layer.provide(NodeServices.layer),
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(NetService.layer),
        ),
      ),
    ),
  );
});
