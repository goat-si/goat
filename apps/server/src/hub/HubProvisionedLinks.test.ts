import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { EnvironmentId } from "@goat/contracts";

import * as Inbox from "../goatclaw/DecisionInbox.ts";
import * as Profiles from "../goatclaw/PermissionProfiles.ts";
import * as ApprovalHandoffs from "../handoffs/ApprovalHandoffs.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as HubMembership from "./HubMembership.ts";
import { HubOcx, HubOcxError, type OcxOutput } from "./HubOcx.ts";
import * as HubParity from "./HubParity.ts";

const PINNED = "SHA256:pinnedpinnedpinnedpinnedpinnedpinnedpinned0";
const GOAT_LINK = "lnk_fedcba9876543210";
const PERSON_LINK = "lnk_0123456789abcdef";
const portOf = (id: string) => (id === GOAT_LINK ? 42255 : 42256);
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("hub"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: "opencodex-child-bootstrap",
  thread: undefined,
  client: { sessionId: "bootstrap", label: "GOAT cloud machine setup", access: "read-only" },
};

interface Fixture {
  /** Aliases a person linked before GOAT's setup ran. */
  readonly linked?: ReadonlyArray<string>;
  /** Home `ocx link revoke` exit; nonzero leaves the link in place. */
  readonly revokeExit?: number;
  /** `ocx link add` links the device but its answer is lost. */
  readonly addLost?: boolean;
  /** OpenCodex is unreachable when GOAT runs `ocx link add`, so GOAT never learns what it did. */
  readonly addUnreachable?: boolean;
  /** A revoked link's ssh -R tunnel keeps running after its record is gone. */
  readonly strayTunnel?: boolean;
  /** The database a previous instance used, to model a GOAT restart. */
  readonly database?: SqlClient.SqlClient;
}

/** The real membership service and database; the Home's OpenCodex and the device are doubles. */
const setup = Effect.fn("HubProvisionedLinksTest.setup")(function* (fixture: Fixture = {}) {
  const calls: string[] = [];
  const links = new Map((fixture.linked ?? []).map((alias) => [alias, PERSON_LINK]));
  /** Running ssh -R tunnels, by forwarded port. */
  const tunnels = new Map([...links].map(([alias, id]) => [portOf(id), alias]));
  const json = (value: unknown): OcxOutput => ({ code: 0, stdout: JSON.stringify(value) });
  const home = (args: ReadonlyArray<string>): Effect.Effect<OcxOutput, HubOcxError> => {
    calls.push(`home ${args.join(" ")}`);
    const [, command, alias] = args;
    if (command === "status")
      return Effect.succeed(
        json({
          role: "home",
          links: [...links].map(([name, id]) => ({ id, alias: name, tunnelPort: portOf(id) })),
        }),
      );
    if (command === "probe")
      return Effect.succeed(json({ alias, fingerprint: PINNED, keyType: "ssh-ed25519" }));
    if (command === "add") {
      if (fixture.addUnreachable)
        return Effect.fail(
          new HubOcxError({ reason: "unreachable", message: "OpenCodex is down." }),
        );
      links.set(alias!, GOAT_LINK);
      tunnels.set(portOf(GOAT_LINK), alias!);
      return Effect.succeed(
        fixture.addLost ? { code: 124, stdout: "" } : json({ linkId: GOAT_LINK }),
      );
    }
    if (command === "revoke") {
      if (fixture.revokeExit) return Effect.succeed({ code: fixture.revokeExit, stdout: "" });
      for (const [name, id] of links) if (id === args[3]) links.delete(name);
      if (!fixture.strayTunnel) tunnels.delete(portOf(args[3]!));
      return Effect.succeed(json({ linkId: args[3] }));
    }
    return Effect.die(`unexpected ocx ${args.join(" ")}`);
  };
  const context = yield* Layer.build(
    HubMembership.layerWithoutDependencies.pipe(
      Layer.provide(
        Layer.succeed(
          HubOcx,
          HubOcx.of({
            home,
            device: () => Effect.succeed({ code: 0, stdout: "opencodex 2.91.0" }),
            devicePlatform: () => Effect.succeed("posix"),
            connectHubClient: () => Effect.die("unused"),
            pinnedFingerprint: () => Effect.succeed(PINNED),
            prepareDevice: () => Effect.die("unused"),
            directAlias: () => Effect.succeed(true),
            runningTurns: () => Effect.succeed(0),
            deviceHealth: () => Effect.die("unused"),
            homeTunnels: (alias, port) =>
              Effect.sync(() => {
                calls.push(`tunnels ${alias} ${port}`);
                return [...tunnels].filter(
                  ([forwarded, name]) =>
                    forwarded === port || (alias !== undefined && name === alias),
                ).length;
              }),
          }),
        ),
      ),
      Layer.provide(
        Layer.mock(HubParity.HubParity)({
          verify: () =>
            Effect.succeed({ verdict: "ok", checkedAt: 0, failingCheckIds: [], checks: [] }),
        }),
      ),
      // A provisioning join and a release never ask a person.
      Layer.provide(Layer.mock(Inbox.DecisionInbox)({})),
      Layer.provide(Layer.mock(ApprovalHandoffs.ApprovalHandoffs)({})),
      Layer.provide(Layer.mock(Profiles.PermissionProfiles)({})),
      Layer.provideMerge(
        fixture.database === undefined
          ? Sqlite.layerMemory
          : Layer.succeed(SqlClient.SqlClient, fixture.database),
      ),
    ),
  );
  const membership = Context.get(context, HubMembership.HubMembership);
  const sql = Context.get(context, SqlClient.SqlClient);
  return {
    membership,
    calls,
    sql,
    links,
    tunnels,
    /** A person links the alias anew after GOAT's link was revoked. */
    replace: (alias: string) => {
      links.set(alias, PERSON_LINK);
      tunnels.set(portOf(PERSON_LINK), alias);
    },
    audit: sql<{ action: string; target: string; outcome: string }>`SELECT action, target, outcome
      FROM audit_events WHERE action LIKE 'hub.%' ORDER BY id`,
  };
});

it.effect("GOAT revokes the link it added for a cloud machine once that machine is removed", () =>
  Effect.gen(function* () {
    const hub = yield* setup();
    yield* hub.membership.joinProvisioned(scope, "boat-builder");
    hub.calls.length = 0;
    yield* hub.membership.requestRelease("boat-builder");
    expect(yield* hub.membership.pendingReleases).toEqual(["boat-builder"]);
    const released = yield* hub.membership.releaseProvisioned("boat-builder");
    expect(released.state).toBe("ready");
    expect(hub.calls).toEqual([
      "home link status --json",
      `home link revoke --link-id ${GOAT_LINK} --force --yes --json`,
      "home link status --json",
      "tunnels boat-builder 42255",
    ]);
    expect(hub.links.has("boat-builder")).toBe(false);
    expect((yield* hub.audit).at(-1)).toEqual({
      action: "hub.release",
      target: "boat-builder",
      outcome: "ready",
    });
    expect(yield* hub.membership.pendingReleases).toEqual([]);
  }),
);

it.effect("a cloud machine keeps its link until its removal asks, and is never linked after", () =>
  Effect.gen(function* () {
    const hub = yield* setup();
    yield* hub.membership.joinProvisioned(scope, "boat-builder");
    hub.calls.length = 0;
    expect((yield* hub.membership.releaseProvisioned("boat-builder")).state).toBe("ready");
    expect(hub.calls).toEqual([]);
    expect(hub.links.get("boat-builder")).toBe(GOAT_LINK);
    // A setup that was already under way when the machine was removed links nothing.
    yield* hub.membership.requestRelease("boat-other");
    expect((yield* hub.membership.joinProvisioned(scope, "boat-other")).state).toBe("failed");
    expect(hub.links.has("boat-other")).toBe(false);
    const refused = yield* hub.membership.requestRelease("mac-studio").pipe(Effect.flip);
    expect(refused.code).toBe("invalid_request");
  }),
);

it.effect(
  "a link GOAT did not add, or one that replaced its own under the alias, survives the removal",
  () =>
    Effect.gen(function* () {
      for (const replaced of [false, true]) {
        // Not replaced: a person linked the alias first, so GOAT's setup reused that link.
        const hub = yield* setup({ linked: replaced ? [] : ["boat-builder"] });
        yield* hub.membership.joinProvisioned(scope, "boat-builder");
        if (replaced) {
          hub.tunnels.delete(portOf(GOAT_LINK));
          hub.replace("boat-builder");
        }
        hub.calls.length = 0;
        yield* hub.membership.requestRelease("boat-builder");
        // The link GOAT recorded is already gone, which counts as released.
        expect((yield* hub.membership.releaseProvisioned("boat-builder")).state).toBe("ready");
        expect(hub.calls.some((call) => call.includes("revoke"))).toBe(false);
        expect(hub.links.get("boat-builder")).toBe(PERSON_LINK);
        expect(yield* hub.membership.pendingReleases).toEqual([]);
      }
    }),
);

it.effect("a link whose add answer was lost is still GOAT's to release", () =>
  Effect.gen(function* () {
    const hub = yield* setup({ addLost: true });
    expect((yield* hub.membership.joinProvisioned(scope, "boat-builder")).state).toBe("failed");
    yield* hub.membership.requestRelease("boat-builder");
    expect((yield* hub.membership.releaseProvisioned("boat-builder")).state).toBe("ready");
    expect(hub.calls).toContain(`home link revoke --link-id ${GOAT_LINK} --force --yes --json`);
    expect(hub.links.size).toBe(0);
  }),
);

it.effect("a revoke that fails stays pending and is retried after GOAT restarts", () =>
  Effect.gen(function* () {
    const hub = yield* setup({ revokeExit: 1 });
    yield* hub.membership.joinProvisioned(scope, "boat-builder");
    yield* hub.membership.requestRelease("boat-builder");
    expect((yield* hub.membership.releaseProvisioned("boat-builder")).state).toBe("failed");
    expect(hub.links.get("boat-builder")).toBe(GOAT_LINK);
    expect((yield* hub.audit).at(-1)).toMatchObject({ action: "hub.release", outcome: "failed" });

    const restarted = yield* setup({ database: hub.sql });
    restarted.links.set("boat-builder", GOAT_LINK);
    restarted.tunnels.set(portOf(GOAT_LINK), "boat-builder");
    expect(yield* restarted.membership.pendingReleases).toEqual(["boat-builder"]);
    expect((yield* restarted.membership.releaseProvisioned("boat-builder")).state).toBe("ready");
    expect(restarted.calls).toContain(
      `home link revoke --link-id ${GOAT_LINK} --force --yes --json`,
    );
    expect(restarted.links.size).toBe(0);
    expect(yield* restarted.membership.pendingReleases).toEqual([]);
  }),
);

it.effect(
  "a tunnel that outlives its revoked link keeps the release pending until it is gone",
  () =>
    Effect.gen(function* () {
      const hub = yield* setup({ strayTunnel: true });
      yield* hub.membership.joinProvisioned(scope, "boat-builder");
      yield* hub.membership.requestRelease("boat-builder");
      expect((yield* hub.membership.releaseProvisioned("boat-builder")).state).toBe("failed");
      expect(hub.links.size).toBe(0);
      expect(yield* hub.membership.pendingReleases).toEqual(["boat-builder"]);

      const restarted = yield* setup({ database: hub.sql });
      expect((yield* restarted.membership.releaseProvisioned("boat-builder")).state).toBe("ready");
      // The tunnel is looked up by the port the revoked link had.
      expect(restarted.calls).toEqual(["home link status --json", "tunnels boat-builder 42255"]);
      expect((yield* restarted.audit).at(-1)).toMatchObject({
        action: "hub.release",
        outcome: "ready",
      });
      expect(yield* restarted.membership.pendingReleases).toEqual([]);
    }),
);

it.effect("a replacement link does not hide the tunnel GOAT's revoked link left running", () =>
  Effect.gen(function* () {
    const hub = yield* setup({ strayTunnel: true });
    yield* hub.membership.joinProvisioned(scope, "boat-builder");
    yield* hub.membership.requestRelease("boat-builder");
    expect((yield* hub.membership.releaseProvisioned("boat-builder")).state).toBe("failed");
    hub.replace("boat-builder");
    hub.calls.length = 0;
    expect((yield* hub.membership.releaseProvisioned("boat-builder")).state).toBe("failed");
    // Counted by GOAT's old port alone, so the replacement's own tunnel does not count.
    expect(hub.calls).toEqual(["home link status --json", "tunnels undefined 42255"]);
    hub.tunnels.delete(portOf(GOAT_LINK));
    expect((yield* hub.membership.releaseProvisioned("boat-builder")).state).toBe("ready");
    expect(hub.links.get("boat-builder")).toBe(PERSON_LINK);
    expect(hub.tunnels.get(portOf(PERSON_LINK))).toBe("boat-builder");
    expect(yield* hub.membership.pendingReleases).toEqual([]);
  }),
);

it.effect("an add GOAT never saw finish claims nothing: a link a person made later stays", () =>
  Effect.gen(function* () {
    const hub = yield* setup({ addUnreachable: true });
    expect((yield* hub.membership.joinProvisioned(scope, "boat-builder")).state).toBe("failed");
    // While GOAT was down, a person linked the alias.
    hub.replace("boat-builder");
    yield* hub.membership.requestRelease("boat-builder");
    hub.calls.length = 0;
    const released = yield* hub.membership.releaseProvisioned("boat-builder");
    expect(released.state).toBe("degraded");
    expect(hub.calls).toEqual(["home link status --json"]);
    expect(hub.links.get("boat-builder")).toBe(PERSON_LINK);
    expect((yield* hub.audit).at(-1)).toMatchObject({ action: "hub.release", outcome: "unproven" });
    expect(yield* hub.membership.pendingReleases).toEqual([]);
  }),
);
