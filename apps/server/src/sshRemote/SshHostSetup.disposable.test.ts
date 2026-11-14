import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it, vi } from "@effect/vitest";
import { AuthSessionId, SSH_PREFLIGHT_STEP_ORDER, type SshPreflightReport } from "@goat/contracts";
import * as SshConfig from "@goat/ssh/config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as SessionStore from "../auth/SessionStore.ts";
import type { DisposableRecord } from "../hub/disposable/disposableClass.ts";
import { DisposableMachineStore } from "../hub/disposable/DisposableMachineStore.ts";
import * as DisposableRouteGuard from "../hub/disposable/DisposableRouteGuard.ts";
import * as SshHostKeys from "./SshHostKeys.ts";
import * as SshHostSetup from "./SshHostSetup.ts";
import * as SshRemoteDispatch from "./SshRemoteDispatch.ts";
import { dependencies } from "./testkit/SshHostSetupTestkit.ts";

// Design section 6: Settings → Connections → Add device → SSH and the agent's SSH add both run this
// preflight, so a disposable machine is refused here, before host-key trust, provisioning and saves.
const node = "c".repeat(26);
const PIN = "SHA256:WifIJ3Gg9d1V01c9+p+oi1SGRxLsJBBVzcaovKcEIAM";
const KEY = "AAAAC3NzaC1lZDI1NTE5AAAAIJqQutSw0XQo7KOx5R7x4wcb2s6h3WPkcz2z6WIeJ3Re";
const record: DisposableRecord = {
  attachId: "attach-1",
  nodeId: node,
  state: "attaching",
  stateSince: "2026-11-14T00:00:00.000Z",
  createdAt: "2026-11-14T00:00:00.000Z",
  provisioner: { kind: "person" },
  final: false,
  environmentId: null,
  machineInstallId: null,
  sshdPin: null,
  linkId: null,
  conflicts: [],
  penMember: true,
};
const reviewer = AuthSessionId.make("reviewer");
const reviewerSession = Layer.mock(SessionStore.SessionStore)({
  cookieName: "test",
  legacyCookieName: undefined,
  listActive: () =>
    Effect.succeed([
      {
        sessionId: reviewer,
        subject: "reviewer",
        method: "browser-session-cookie",
        scopes: ["settings:write"],
        client: { label: "Reviewer", deviceType: "unknown" },
        issuedAt: DateTime.makeUnsafe(0),
        expiresAt: DateTime.makeUnsafe(9999999999999),
        lastConnectedAt: null,
        connected: true,
      },
    ] as never),
});

const preflightOf = (
  records: ReadonlyArray<DisposableRecord>,
  hostKeys: Readonly<Record<string, string>>,
  host: string,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-preflight-disposable-" });
    const probes: Array<string> = [];
    const discover = vi.spyOn(SshConfig, "discoverSshHosts").mockReturnValue(
      Effect.succeed(
        ["pen-cc-07", "lab", "box"].map((alias) => ({
          alias,
          hostname: "box.example",
          username: "jun",
          port: 22,
          source: "ssh-config" as const,
        })),
      ),
    );
    const guard = Layer.effect(
      DisposableRouteGuard.DisposableRouteGuard,
      DisposableRouteGuard.make(Effect.succeed(`pen-cc-07,pen-${node} ssh-ed25519 ${KEY}\n`)),
    ).pipe(
      Layer.provide(Layer.mock(DisposableMachineStore)({ recordsOrKept: Effect.succeed(records) })),
      Layer.provide(
        Layer.succeed(SshHostKeys.SshHostKeys, {
          negotiatedFingerprint: (target) =>
            Effect.sync(() => {
              probes.push(target.alias);
              return hostKeys[target.alias];
            }),
        }),
      ),
    );
    const report = yield* Effect.gen(function* () {
      const layer = Layer.effect(
        SshHostSetup.SshHostSetup,
        SshHostSetup.make({
          home,
          runPreflight: (input): Effect.Effect<SshPreflightReport> =>
            Effect.succeed({
              host: input.host,
              destination: { alias: input.host, hostname: "box.example", user: "jun", port: 22 },
              ready: true,
              steps: SSH_PREFLIGHT_STEP_ORDER.map((id) => ({
                id,
                state: "passed" as const,
                summary: "Checked.",
                ...(id === "host_key" ? { fingerprint: PIN } : {}),
              })),
            }),
        }),
      ).pipe(
        Layer.provide(guard),
        Layer.provide(reviewerSession),
        Layer.provide(Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({})),
        Layer.provide(dependencies),
      );
      const setup = Context.get(yield* Layer.build(layer), SshHostSetup.SshHostSetup);
      return yield* setup.preflight({ host }, { kind: "client", sessionId: reviewer });
    }).pipe(Effect.ensuring(Effect.sync(() => discover.mockRestore())));
    return { report, probes, hostKey: report.steps.find((step) => step.id === "host_key") };
  }).pipe(Effect.provide(NodeServices.layer));

it.effect(
  "preflight fails for Pen's own pen-<name> of a disposable machine with no pin yet, offline, with no key probe and no fingerprint",
  () =>
    Effect.gen(function* () {
      const { report, probes, hostKey } = yield* preflightOf([record], {}, "pen-cc-07");
      expect(report.ready).toBe(false);
      expect(hostKey).toMatchObject({ state: "failed" });
      expect(hostKey?.detail).toContain("disposable machine");
      expect(hostKey?.fingerprint).toBeUndefined();
      expect(probes).toEqual([]);
    }),
);

it.effect(
  "preflight fails for an alias whose offered ED25519 key is a disposable machine's pin, and passes a kept host as it was",
  () =>
    Effect.gen(function* () {
      const pinned = [{ ...record, sshdPin: PIN }];
      const refused = yield* preflightOf(pinned, { lab: PIN }, "lab");
      expect(refused.report.ready).toBe(false);
      expect(refused.hostKey?.detail).toContain("SSH host key it offered");
      const kept = yield* preflightOf(pinned, { box: "SHA256:other" }, "box");
      expect(kept.report.ready).toBe(true);
      expect(kept.hostKey).toMatchObject({ state: "passed", fingerprint: PIN });
    }),
);
