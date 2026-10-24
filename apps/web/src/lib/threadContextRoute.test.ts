import {
  BearerConnectionProfile,
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionProfile,
  SshConnectionTarget,
  type ConnectionCatalogEntry,
} from "@goat/client-runtime/connection";
import { EnvironmentId, ThreadId } from "@goat/contracts";
import {
  formatComposerContextReference,
  threadContextsOutsideEnvironment,
} from "@goat/shared/composerContextReferences";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { threadContextRecord } from "./composerContextRecords";
import {
  resolveThreadContextRoute,
  routeThreadContextRecord,
  routeThreadContextRecords,
  settleThreadContextsForAgent,
} from "./threadContextRoute";

const primaryId = EnvironmentId.make("env-primary");
const laptopId = EnvironmentId.make("env-laptop");
const cloudId = EnvironmentId.make("env-cloud");
const wslId = EnvironmentId.make("env-wsl");

const primary: ConnectionCatalogEntry = {
  target: new PrimaryConnectionTarget({
    environmentId: primaryId,
    label: "This Mac",
    httpBaseUrl: "http://127.0.0.1:3773",
    wsBaseUrl: "ws://127.0.0.1:3773",
  }),
  profile: Option.none(),
  enabled: true,
};

const sshProfile = (environmentId: EnvironmentId, alias: string) =>
  new SshConnectionProfile({
    connectionId: `ssh-${environmentId}`,
    environmentId,
    // The display label deliberately differs from the alias: only the alias routes.
    label: "Jun's MacBook Pro",
    target: { alias, hostname: "192.168.0.20", username: "jun", port: 22 },
  });

const laptopOverSsh: ConnectionCatalogEntry = {
  target: new SshConnectionTarget({
    environmentId: laptopId,
    label: "Jun's MacBook Pro",
    connectionId: `ssh-${laptopId}`,
  }),
  profile: Option.some(sshProfile(laptopId, "juns-macbook-pro")),
  enabled: true,
};

const cloudOnly: ConnectionCatalogEntry = {
  target: new RelayConnectionTarget({ environmentId: cloudId, label: "Cloud box" }),
  profile: Option.none(),
  alternateRoutes: [
    {
      target: new BearerConnectionTarget({
        environmentId: cloudId,
        label: "Cloud box",
        connectionId: "bearer-cloud",
      }),
      profile: Option.some(
        new BearerConnectionProfile({
          connectionId: "bearer-cloud",
          environmentId: cloudId,
          label: "Cloud box",
          httpBaseUrl: "https://cloud.example.test",
          wsBaseUrl: "wss://cloud.example.test",
        }),
      ),
    },
  ],
  enabled: true,
};

const wslBackend: ConnectionCatalogEntry = {
  target: new BearerConnectionTarget({
    environmentId: wslId,
    label: "WSL (Ubuntu)",
    connectionId: "local:wsl:Ubuntu",
  }),
  profile: Option.none(),
  enabled: true,
};

const entries = new Map([
  [primaryId, primary],
  [laptopId, laptopOverSsh],
  [cloudId, cloudOnly],
  [wslId, wslBackend],
]);

const resolve = (
  agentEnvironmentId: EnvironmentId,
  threadEnvironmentId: EnvironmentId,
  overrides: { entries?: ReadonlyMap<EnvironmentId, ConnectionCatalogEntry> } & {
    isDesktopRenderer?: boolean;
  } = {},
) =>
  resolveThreadContextRoute({
    agentEnvironmentId,
    threadEnvironmentId,
    entries: overrides.entries ?? entries,
    isDesktopRenderer: overrides.isDesktopRenderer ?? true,
  });

describe("resolveThreadContextRoute", () => {
  it("needs no host for a thread on the agent's own server", () => {
    expect(resolve(laptopId, laptopId)).toEqual({ kind: "local" });
  });

  it("routes another environment through the saved SSH alias, never its display label", () => {
    expect(resolve(primaryId, laptopId)).toEqual({ kind: "ssh", host: "juns-macbook-pro" });
  });

  it("finds an SSH route saved behind a preferred T3 Connect route", () => {
    const relayFirst: ConnectionCatalogEntry = {
      target: new RelayConnectionTarget({ environmentId: laptopId, label: "Jun's MacBook Pro" }),
      profile: Option.none(),
      alternateRoutes: [{ target: laptopOverSsh.target, profile: laptopOverSsh.profile }],
      enabled: true,
    };
    expect(
      resolve(primaryId, laptopId, { entries: new Map([...entries, [laptopId, relayFirst]]) }),
    ).toEqual({ kind: "ssh", host: "juns-macbook-pro" });
  });

  it("refuses an environment saved without SSH", () => {
    expect(resolve(primaryId, cloudId)).toEqual({
      kind: "unreachable",
      reason: "no-ssh-connection",
    });
  });

  it("refuses when the agent's server does not share the desktop app's SSH config", () => {
    // A remote agent cannot resolve this client's aliases, not even for this machine.
    expect(resolve(laptopId, primaryId)).toEqual({
      kind: "unreachable",
      reason: "agent-not-on-this-device",
    });
    expect(resolve(wslId, laptopId)).toEqual({
      kind: "unreachable",
      reason: "agent-not-on-this-device",
    });
    // In a browser, the primary may be on any machine.
    expect(resolve(primaryId, laptopId, { isDesktopRenderer: false })).toEqual({
      kind: "unreachable",
      reason: "agent-not-on-this-device",
    });
  });

  it("refuses a thread whose environment is no longer saved", () => {
    expect(resolve(primaryId, EnvironmentId.make("env-gone"))).toEqual({
      kind: "unreachable",
      reason: "unknown-environment",
    });
  });
});

describe("routeThreadContextRecord", () => {
  const record = threadContextRecord(
    { environmentId: laptopId, threadId: ThreadId.make("thread-1") },
    "Remote work",
  );

  it("sets the host for another environment and drops a stale one for the agent's own", () => {
    const routed = routeThreadContextRecord(record, { kind: "ssh", host: "juns-macbook-pro" });
    expect(routed.host).toBe("juns-macbook-pro");
    expect("host" in routeThreadContextRecord(routed, { kind: "local" })).toBe(false);
  });
});

describe("routeThreadContextRecords", () => {
  it("attaches the reachable part of a mixed drop and explains the refused part", () => {
    const { routed, refusal } = routeThreadContextRecords({
      records: [
        threadContextRecord({ environmentId: laptopId, threadId: ThreadId.make("t-laptop") }, "A"),
        threadContextRecord({ environmentId: cloudId, threadId: ThreadId.make("t-cloud") }, "B"),
        threadContextRecord({ environmentId: primaryId, threadId: ThreadId.make("t-own") }, "C"),
      ],
      agentEnvironmentId: primaryId,
      entries,
      isDesktopRenderer: true,
    });
    expect(routed.map((record) => [record.threadId, record.host])).toEqual([
      ["t-laptop", "juns-macbook-pro"],
      ["t-own", undefined],
    ]);
    expect(refusal?.title).toContain("Cloud box");
    expect(refusal?.description).toContain("SSH");
  });
});

describe("settleThreadContextsForAgent", () => {
  it("allows a settled SSH reference, then blocks it after moving to an unrelated environment", () => {
    const record = threadContextRecord(
      { environmentId: laptopId, threadId: ThreadId.make("remote") },
      "Remote",
    );
    const text = formatComposerContextReference(record);
    const settle = (environmentId: EnvironmentId) =>
      settleThreadContextsForAgent({
        records: [record],
        agentEnvironmentId: environmentId,
        entries,
        isDesktopRenderer: true,
      });
    const onPrimary = settle(primaryId);
    expect(onPrimary[0]?.host).toBe("juns-macbook-pro");
    expect(
      threadContextsOutsideEnvironment({
        text,
        records: onPrimary,
        environmentId: primaryId,
        hostRoutingEnvironmentId: primaryId,
      }),
    ).toEqual([]);
    const onCloud = settle(cloudId);
    expect(onCloud[0]?.host).toBeUndefined();
    expect(
      threadContextsOutsideEnvironment({
        text,
        records: onCloud,
        environmentId: cloudId,
        hostRoutingEnvironmentId: cloudId,
      }),
    ).toEqual(onCloud);
    const onLaptop = settle(laptopId);
    expect(onLaptop[0]?.host).toBeUndefined();
    expect(
      threadContextsOutsideEnvironment({ text, records: onLaptop, environmentId: laptopId }),
    ).toEqual([]);
  });

  it("re-settles hosts when a draft is sent from another environment", () => {
    const attachedOnPrimary = routeThreadContextRecord(
      threadContextRecord({ environmentId: laptopId, threadId: ThreadId.make("t-laptop") }, "A"),
      { kind: "ssh", host: "juns-macbook-pro" },
    );
    // Sent from the laptop itself, the thread is local and needs no host.
    const [onLaptop] = settleThreadContextsForAgent({
      records: [attachedOnPrimary],
      agentEnvironmentId: laptopId,
      entries,
      isDesktopRenderer: true,
    });
    expect(onLaptop?.host).toBeUndefined();
    // Sent from the cloud box, the primary's alias means nothing there.
    const [onCloud] = settleThreadContextsForAgent({
      records: [attachedOnPrimary],
      agentEnvironmentId: cloudId,
      entries,
      isDesktopRenderer: true,
    });
    expect(onCloud?.host).toBeUndefined();
  });
});
