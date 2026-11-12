import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OpenCodexChildBootstrapStatus,
  type OpenCodexInventorySnapshot,
} from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import { servedRuntimeProtocolRanges } from "@goat/shared/sshRuntimeProtocol";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import packageJson from "../../package.json" with { type: "json" };
import { HOST_STATUS_REMOTE_TIMEOUT_MS } from "./HostStatusMcpService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import {
  pool,
  threadId,
  scope,
  capacity,
  decode,
  encodeHostStatus,
  limits,
  provider,
  remoteOk,
  sshError,
  run,
} from "./HostStatusMcpService.testkit.ts";

it.effect("fan-out preserves a host's inventory and accepts older hosts that omit it", () =>
  Effect.gen(function* () {
    const inventory: OpenCodexInventorySnapshot = {
      installed: true,
      binaries: [{ path: "/fixture/ocx", version: "2.86.0" }],
      ownership: "adopted",
      service: { available: false },
      runtime: { port: 10100, version: "2.86.0", role: "client", healthy: true, ready: true },
      link: { role: "child", available: true, links: [], childSettingsApplied: true },
    };
    const { value } = yield* run(
      {
        hosts: ["child", "legacy"],
        hostCall: (call) =>
          Effect.succeed(remoteOk(9, call.host === "child" ? inventory : undefined)),
      },
      (service) => service.read(scope, {}),
    );
    expect(value._tag).toBe("Success");
    if (value._tag !== "Success") return;
    const hosts = decode(value.success).hosts;
    expect(hosts.find((host) => host.host === "child")?.metrics?.opencodex).toEqual(inventory);
    expect(hosts.find((host) => host.host === "legacy")?.metrics?.opencodex).toBeUndefined();
    expect(hosts.find((host) => host.host === null)?.metrics?.opencodex?.ownership).toBe("none");
  }),
);

it.effect("rejects remote parity evidence before collecting repository inventory", () =>
  Effect.gen(function* () {
    const result = yield* run({ hosts: ["box"] }, (service) =>
      service.read(scope, { host: "box", repositories: true, parityEvidence: true }),
    );
    expect(result.value._tag).toBe("Failure");
    expect(result.repositoryReads).toBe(0);
    expect(result.parityReads).toBe(0);
    expect(result.calls).toHaveLength(0);
  }),
);

it.effect("includes this machine's OpenCodex pool in its decoded host metrics", () =>
  Effect.gen(function* () {
    const { value } = yield* run({ quotaPool: pool }, (service) =>
      service.read(scope, { local: true }),
    );
    expect(value._tag).toBe("Success");
    if (value._tag !== "Success") return;
    expect(decode(value.success).hosts[0]?.metrics?.quotaPool).toEqual(pool);
  }),
);

it.effect("shows this Home's Child setup on the cloud machine it is joining", () =>
  Effect.gen(function* () {
    const blocked: OpenCodexChildBootstrapStatus = {
      state: "blocked",
      checkedAt: 7,
      reason: "npm_missing",
      message: "npm is not installed there.",
    };
    const { value } = yield* run(
      {
        hosts: ["boat-builder", "box"],
        children: { "boat-builder": blocked },
        hostCall: () => Effect.succeed(remoteOk(9)),
      },
      (service) => service.read(scope, {}),
    );
    expect(value._tag).toBe("Success");
    if (value._tag !== "Success") return;
    const hosts = decode(value.success).hosts;
    expect(hosts.find((host) => host.host === "boat-builder")?.opencodexChild).toEqual(blocked);
    expect(hosts.find((host) => host.host === "box")?.opencodexChild).toBeUndefined();
    expect(hosts.find((host) => host.host === null)?.opencodexChild).toBeUndefined();
  }),
);

it.effect("says which SSH hosts this hub joins as Children after their setup", () =>
  Effect.gen(function* () {
    const { value } = yield* run(
      {
        hosts: ["boat-builder", "box", "lab"],
        optIns: { box: true, lab: false },
        hostCall: () => Effect.succeed(remoteOk(9)),
      },
      (service) => service.read(scope, {}),
    );
    expect(value._tag).toBe("Success");
    if (value._tag !== "Success") return;
    const hosts = decode(value.success).hosts;
    expect(hosts.map((host) => [host.host, host.opencodexChildOptIn])).toEqual([
      [null, undefined],
      ["boat-builder", undefined],
      ["box", true],
      ["lab", false],
    ]);
  }),
);

it.effect("fans out to this machine and each connected host, sorted", () =>
  Effect.gen(function* () {
    const { value, calls, queries, refreshes } = yield* run(
      {
        hosts: ["zeta", "box"],
        providers: [
          provider("codex", limits("2026-10-12T15:00:00.000Z"), "Codex"),
          provider("claude", undefined),
          provider("api", limits("2026-10-12T15:00:00.000Z", "unsupported"), "API"),
        ],
        hostCall: (call) =>
          call.host === "box"
            ? Effect.succeed(remoteOk(9))
            : Effect.fail(
                sshError(
                  "remote_refused",
                  "GOAT on zeta could not run goat_host_status: Tool 'goat_host_status' not found",
                ),
              ),
      },
      (service, probes) =>
        service.read(scope, {}).pipe(Effect.tap(() => Queue.take(probes.started))),
    );
    expect(value._tag).toBe("Success");
    if (value._tag !== "Success") return;
    const decoded = decode(value.success);
    expect(decoded.hosts.map((host) => [host.host, host.reachability])).toEqual([
      [null, "ok"],
      ["box", "ok"],
      ["zeta", "unsupported"],
    ]);
    expect(decoded.hosts[0]?.metrics).toMatchObject({
      ...capacity,
      threads: { running: 1, waiting: 1, queued: 1 },
      quotas: [
        { instanceId: "codex", displayName: "Codex", fromCache: true },
        { instanceId: "api", displayName: "API", fromCache: true },
      ],
    });
    // Quotas omit claude, which reports no usage limits. Providers lists every instance; only
    // codex runs a CLI GOAT checks, and it has not been checked yet.
    expect(decoded.hosts[0]?.metrics?.providers).toEqual([
      { instanceId: "codex", driver: "codex", displayName: "Codex", enabled: true, cli: "unknown" },
      { instanceId: "claude", driver: "claude", enabled: true },
      { instanceId: "api", driver: "api", displayName: "API", enabled: true },
    ]);
    expect(decoded.hosts[1]).toMatchObject({ host: "box", metrics: { sampledAt: 9 } });
    expect(decoded.hosts[2]).toEqual({
      host: "zeta",
      reachability: "unsupported",
      message: "GOAT on zeta does not offer goat_host_status. Update GOAT on that machine.",
    });
    expect(calls.map((call) => call.host).toSorted()).toEqual(["box", "zeta"]);
    expect(calls.every((call) => call.tool === "goat_host_status")).toBe(true);
    expect(calls.every((call) => call.writes === false)).toBe(true);
    expect(calls.every((call) => call.timeoutMs === HOST_STATUS_REMOTE_TIMEOUT_MS)).toBe(true);
    expect(calls.every((call) => call.arguments.local === true)).toBe(true);
    expect(queries).toEqual([{ projectId: undefined, includeSubagents: true }]);
    expect(refreshes).toEqual(["codex"]);
  }),
);

it.effect(
  "includes repository inventory only when requested and forwards that request to the selected host",
  () =>
    Effect.gen(function* () {
      const { value, calls } = yield* run(
        {
          hostCall: () =>
            Effect.succeed({
              hosts: [
                {
                  host: null,
                  reachability: "ok",
                  repositories: { sampledAt: 123, entries: [], truncated: true },
                },
              ],
            }),
        },
        (service) =>
          Effect.gen(function* () {
            expect(
              (yield* service.read(scope, { local: true })).hosts[0]?.repositories,
            ).toBeUndefined();
            expect(
              (yield* service.read(scope, { local: true, repositories: true })).hosts[0]
                ?.repositories,
            ).toEqual({ sampledAt: 0, entries: [], truncated: false });
            return yield* service.read(scope, { host: "box", repositories: true });
          }),
      );
      expect(value._tag).toBe("Success");
      if (value._tag === "Success")
        expect(value.success.hosts[0]?.repositories?.truncated).toBe(true);
      expect(calls[0]?.arguments).toEqual({ local: true, repositories: true });
    }),
);

it.effect("judges each host by the protocols it serves, not by its version string", () =>
  Effect.gen(function* () {
    const served = servedRuntimeProtocolRanges();
    const answers: Record<string, { serverVersion?: string; protocol?: unknown }> = {
      same: { serverVersion: packageJson.version, protocol: served },
      // Another channel's build that serves the same protocols works with this machine.
      nightly: { serverVersion: "0.1.0-nightly.20261019.195", protocol: served },
      // Older than protocol reporting: it answers, but cannot show compatibility.
      old: {},
      ancient: {
        serverVersion: "0.0.9",
        protocol: { ssh: served.ssh, orchestration: { min: 1, max: 1 } },
      },
    };
    const { value } = yield* run(
      {
        hosts: Object.keys(answers),
        hostCall: (call) => {
          const answer = remoteOk(3);
          return Effect.succeed({
            hosts: answer.hosts.map((entry) => ({ ...entry, ...answers[call.host] })),
          });
        },
      },
      (service) => service.read(scope, {}),
    );
    expect(value._tag).toBe("Success");
    if (value._tag !== "Success") return;
    const byHost = new Map(decode(value.success).hosts.map((entry) => [entry.host, entry]));
    const local = byHost.get(null);
    expect(local).toMatchObject({ serverVersion: packageJson.version, protocol: served });
    expect(local?.compatibility).toBeUndefined();
    expect(local?.versionMismatch).toBeUndefined();

    const same = byHost.get("same");
    expect(same).toMatchObject({ compatibility: "compatible" });
    expect(same?.versionMismatch).toBeUndefined();
    expect(same?.message).toBeUndefined();

    const nightly = byHost.get("nightly");
    expect(nightly).toMatchObject({ compatibility: "compatible", versionMismatch: true });
    expect(nightly?.message).toBeUndefined();

    const old = byHost.get("old");
    expect(old).toMatchObject({ compatibility: "degraded", versionMismatch: true });
    expect(old?.message).toContain("does not report the protocols it serves");
    expect(old?.message).toContain("update GOAT on old");

    const ancient = byHost.get("ancient");
    expect(ancient).toMatchObject({ compatibility: "incompatible", versionMismatch: true });
    expect(ancient?.message).toContain("serving orchestration 1, SSH");
    expect(ancient?.message).toMatch(/Update GOAT on ancient\.$/);
  }),
);

it.effect("reads only this machine for a client session that may not reach hosts", () =>
  Effect.gen(function* () {
    const { value, calls, connectedReads } = yield* run(
      { hosts: ["box"], hostCall: () => Effect.die("read-only session reached SSH") },
      (service) =>
        service
          .readForClient({
            environmentId: EnvironmentId.make("host-status-test"),
            sessionId: "web-session",
            reachHosts: false,
          })
          .pipe(Effect.provideService(HostProcess.Platform, "win32")),
    );
    expect(connectedReads()).toBe(0);
    expect(calls).toEqual([]);
    expect(value._tag).toBe("Success");
    if (value._tag !== "Success") return;
    expect(value.success.hosts).toHaveLength(1);
    expect(value.success.hosts[0]).toMatchObject({
      host: null,
      reachability: "ok",
      metrics: { platform: "win32", threads: { running: 1, waiting: 1, queued: 1 } },
    });
  }),
);

it.effect("reads only this machine when a client that may reach hosts asks for local", () =>
  Effect.gen(function* () {
    const { value, calls, connectedReads } = yield* run(
      { hosts: ["box"], hostCall: () => Effect.die("local read reached SSH") },
      (service) =>
        service.readForClient({
          environmentId: EnvironmentId.make("host-status-test"),
          sessionId: "web-session",
          reachHosts: true,
          local: true,
        }),
    );
    expect(connectedReads()).toBe(0);
    expect(calls).toEqual([]);
    expect(value._tag).toBe("Success");
    if (value._tag !== "Success") return;
    expect(value.success.hosts.map((host) => [host.host, host.reachability])).toEqual([
      [null, "ok"],
    ]);
  }),
);

it.effect("fans out for a client session that may reach hosts, reading only", () =>
  Effect.gen(function* () {
    const { value, calls } = yield* run({ hosts: ["box"] }, (service) =>
      service.readForClient({
        environmentId: EnvironmentId.make("host-status-test"),
        sessionId: "web-session",
        reachHosts: true,
      }),
    );
    expect(value._tag).toBe("Success");
    if (value._tag !== "Success") return;
    expect(value.success.hosts.map((host) => [host.host, host.reachability])).toEqual([
      [null, "ok"],
      ["box", "ok"],
    ]);
    expect(calls).toMatchObject([
      { host: "box", tool: "goat_host_status", writes: false, arguments: { local: true } },
    ]);
  }),
);

it.effect("returns the last sample when a host that answered goes unreachable", () =>
  Effect.gen(function* () {
    let down = false;
    const { value } = yield* run(
      {
        hosts: ["box", "old-mac"],
        hostCall: (call) => {
          if (call.host === "old-mac") {
            return Effect.fail(sshError("remote_refused", "Tool 'goat_host_status' not found"));
          }
          return down
            ? Effect.fail(sshError("host_unavailable", "box is unavailable: timed out"))
            : Effect.succeed(remoteOk(9));
        },
      },
      (service) =>
        Effect.gen(function* () {
          const first = yield* service.read(scope, {});
          down = true;
          const second = yield* service.read(scope, {});
          return { first, second };
        }),
    );
    expect(value._tag).toBe("Success");
    if (value._tag !== "Success") return;
    const box = value.success.second.hosts.find((host) => host.host === "box");
    const old = value.success.second.hosts.find((host) => host.host === "old-mac");
    expect(box).toMatchObject({
      reachability: "unreachable",
      lastKnown: true,
      message: "box is unavailable: timed out",
      metrics: { sampledAt: 9 },
    });
    expect(old).toEqual({
      host: "old-mac",
      reachability: "unsupported",
      message: "GOAT on old-mac does not offer goat_host_status. Update GOAT on that machine.",
    });
    expect(old?.metrics).toBeUndefined();
    expect(old?.lastKnown).toBeUndefined();
  }),
);

it.effect("reports this machine from its last sample when counting threads fails", () =>
  Effect.gen(function* () {
    let listFails = false;
    const { value, connectedReads } = yield* run(
      {
        get listFails() {
          return listFails;
        },
        hostCall: () => Effect.die("local read reached SSH"),
      },
      (service) =>
        Effect.gen(function* () {
          const first = yield* service.read(scope, { local: true });
          listFails = true;
          const second = yield* service.read(scope, { local: true });
          return { first, second };
        }),
    );
    expect(connectedReads()).toBe(0);
    expect(value._tag).toBe("Success");
    if (value._tag !== "Success") return;
    expect(value.success.first.hosts).toMatchObject([
      {
        host: null,
        reachability: "ok",
        metrics: { threads: { running: 1, waiting: 1, queued: 1 } },
      },
    ]);
    expect(value.success.second.hosts[0]).toMatchObject({
      host: null,
      reachability: "unreachable",
      lastKnown: true,
      message: "Could not count threads on this machine.",
    });
  }),
);

it.effect("refuses host and local together, and an unknown named host", () =>
  Effect.gen(function* () {
    const { value, calls, connectedReads } = yield* run(
      {
        hostCall: () => Effect.fail(sshError("host_unknown", "No SSH host named ghost.")),
      },
      (service) =>
        Effect.gen(function* () {
          const both = yield* service.read(scope, { host: "box", local: true }).pipe(Effect.result);
          const ghost = yield* service.read(scope, { host: "ghost" }).pipe(Effect.result);
          return { both, ghost };
        }),
    );
    expect(connectedReads()).toBe(0);
    expect(calls.map((call) => call.host)).toEqual(["ghost"]);
    expect(value._tag).toBe("Success");
    if (value._tag !== "Success") return;
    expect(value.success.both._tag === "Failure" && value.success.both.failure.code).toBe(
      "invalid_request",
    );
    expect(value.success.ghost._tag === "Failure" && value.success.ghost.failure.code).toBe(
      "invalid_request",
    );
  }),
);

it.effect("keeps a fan-out going when one host never finishes connecting", () =>
  Effect.gen(function* () {
    const reached = yield* Deferred.make<void>();
    const { value } = yield* run(
      {
        hosts: ["box", "stuck"],
        // Connecting never finishes, so the call's own deadline never starts.
        hostCall: (call) =>
          call.host === "stuck"
            ? Deferred.succeed(reached, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.succeed(remoteOk(5)),
      },
      (service) =>
        Effect.gen(function* () {
          const read = yield* Effect.forkChild(service.read(scope, {}));
          yield* Deferred.await(reached);
          yield* TestClock.adjust(HOST_STATUS_REMOTE_TIMEOUT_MS);
          return yield* Fiber.join(read);
        }),
    );
    expect(value._tag).toBe("Success");
    if (value._tag !== "Success") return;
    expect(value.success.hosts.map((host) => [host.host, host.reachability])).toEqual([
      [null, "ok"],
      ["box", "ok"],
      ["stuck", "unreachable"],
    ]);
    expect(value.success.hosts[1]?.metrics?.sampledAt).toBe(5);
    expect(value.success.hosts[2]?.message).toBe("stuck did not answer within 10s.");
  }),
);

it.effect("keeps a slow host's connection going across polls and keeps its late answer", () =>
  Effect.gen(function* () {
    const reached = yield* Deferred.make<void>();
    const connected = yield* Deferred.make<void>();
    let down = false;
    let slowCalls = 0;
    const { value, calls } = yield* run(
      {
        hosts: ["slow"],
        hostCall: () => {
          slowCalls += 1;
          return down
            ? Effect.fail(sshError("host_unavailable", "slow is unavailable: refused"))
            : Deferred.succeed(reached, undefined).pipe(
                Effect.andThen(Deferred.await(connected)),
                Effect.as(remoteOk(7)),
              );
        },
      },
      (service) =>
        Effect.gen(function* () {
          const firstRead = yield* Effect.forkChild(service.read(scope, {}));
          yield* Deferred.await(reached);
          yield* TestClock.adjust(HOST_STATUS_REMOTE_TIMEOUT_MS);
          const first = yield* Fiber.join(firstRead);
          const secondRead = yield* Effect.forkChild(service.read(scope, {}));
          yield* TestClock.adjust(HOST_STATUS_REMOTE_TIMEOUT_MS);
          const second = yield* Fiber.join(secondRead);
          const callsWhileConnecting = slowCalls;
          yield* Deferred.succeed(connected, undefined);
          down = true;
          const third = yield* service.read(scope, {});
          return { first, second, third, callsWhileConnecting };
        }),
    );
    expect(value._tag).toBe("Success");
    if (value._tag !== "Success") return;
    expect(value.success.first.hosts[1]).toMatchObject({
      host: "slow",
      reachability: "unreachable",
    });
    expect(value.success.second.hosts[1]).toMatchObject({
      host: "slow",
      reachability: "unreachable",
    });
    // The second poll waited on the connection already under way instead of starting another.
    expect(value.success.callsWhileConnecting).toBe(1);
    // The answer that arrived after both deadlines stands in once the host stops answering.
    expect(value.success.third.hosts[1]).toMatchObject({
      host: "slow",
      reachability: "unreachable",
      lastKnown: true,
      metrics: { sampledAt: 7 },
    });
    expect(calls).toHaveLength(2);
  }),
);

it.effect("keeps the rest of a host and the other hosts when one metrics section is not JSON", () =>
  Effect.gen(function* () {
    const opencodex: OpenCodexInventorySnapshot = {
      installed: true,
      binaries: [],
      ownership: "adopted",
      service: { available: false },
      runtime: { port: 10100, healthy: true, ready: true },
      link: {
        role: "home",
        available: true,
        links: [
          {
            id: "mini",
            alias: "mini",
            tunnelPort: 10100,
            state: "connected",
            lastApplyAt: undefined,
          },
        ],
        childSettingsApplied: false,
      },
    };
    const { value } = yield* run(
      {
        hosts: ["gone"],
        opencodex,
        hostCall: () => Effect.fail(sshError("ssh_failed", "ssh failed")),
      },
      (service) =>
        Effect.gen(function* () {
          const localOnly = yield* service.read(scope, { local: true });
          const fanout = yield* service.read(scope, {});
          return { localOnly, fanout };
        }),
    );
    expect(value._tag).toBe("Success");
    if (value._tag !== "Success") return;
    for (const result of [value.success.localOnly, value.success.fanout]) {
      yield* encodeHostStatus(result);
      const local = result.hosts[0];
      expect(local?.reachability).toBe("ok");
      expect(local?.metrics?.opencodex).toBeUndefined();
      expect(local?.metrics?.cpuCount).toBe(8);
      expect(local?.omittedMetrics).toEqual([
        {
          section: "opencodex",
          message: "opencodex.link.links.0.lastApplyAt is undefined",
        },
      ]);
    }
    expect(value.success.fanout.hosts[1]).toMatchObject({
      host: "gone",
      reachability: "unreachable",
      message: "ssh failed",
    });
  }),
);

it.effect("keeps a fan-out going when one host is unknown", () =>
  Effect.gen(function* () {
    const { value } = yield* run(
      {
        hosts: ["ghost"],
        hostCall: () => Effect.fail(sshError("invalid_request", "No SSH host named ghost.")),
      },
      (service) => service.read(scope, {}),
    );
    expect(value._tag).toBe("Success");
    if (value._tag !== "Success") return;
    expect(value.success.hosts[1]).toMatchObject({
      host: "ghost",
      reachability: "unreachable",
      message: "No SSH host named ghost.",
    });
    expect(value.success.hosts[1]?.lastKnown).toBeUndefined();
  }),
);

it.effect("fails the whole call when the caller may not use SSH", () =>
  Effect.gen(function* () {
    const denied: McpInvocationScope = { ...scope, capabilities: new Set() };
    const { value: capability, calls: capabilityCalls } = yield* run(
      { hostCall: () => Effect.die("denied caller reached SSH") },
      (service) => service.read(denied, { host: "box" }),
    );
    const { value: inactive, calls: inactiveCalls } = yield* run(
      {
        shell: {
          ...liveThreadShell(threadId),
          archivedAt: DateTime.makeUnsafe("2026-10-01T00:00:00.000Z"),
        },
        hostCall: () => Effect.die("inactive caller reached SSH"),
      },
      (service) => service.read(scope, { host: "box" }),
    );
    const { value: changed } = yield* run(
      {
        hosts: ["box"],
        hostCall: () => Effect.fail(sshError("caller_changed", "The caller changed.")),
      },
      (service) => service.read(scope, {}),
    );
    expect(capabilityCalls).toEqual([]);
    expect(inactiveCalls).toEqual([]);
    expect(capability._tag === "Failure" && capability.failure.code).toBe("capability_denied");
    expect(inactive._tag === "Failure" && inactive.failure.code).toBe("parent_not_active");
    expect(changed._tag === "Failure" && changed.failure.code).toBe(
      "runtime_mode_escalation_denied",
    );
  }),
);

it.effect("treats a remote payload this tool cannot read as unreachable", () =>
  Effect.gen(function* () {
    const { value } = yield* run(
      {
        hostCall: () => Effect.succeed({ hosts: [{ host: null, reachability: "sometimes" }] }),
      },
      (service) => service.read(scope, { host: "box" }),
    );
    expect(value._tag).toBe("Success");
    if (value._tag !== "Success") return;
    expect(value.success.hosts[0]).toMatchObject({
      host: "box",
      reachability: "unreachable",
      message: "box returned a result goat_host_status could not read.",
    });
  }),
);
