import { expect, it } from "@effect/vitest";
import { HubDeviceMcpResult } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { PINNED, scope, setup, threadScope } from "./HubMembership.testkit.ts";

const OLD = "lnk_0123456789abcdef";
const decodeResult = Schema.decodeUnknownSync(HubDeviceMcpResult);
const move = { fromAlias: "mini", toAlias: "pen-mini" };
// A profile that may manage hosts but is not the owner: every move asks a person.
const asking = { profile: "hub-admin", linked: ["mini"] } as const;

it.effect(
  "one approval moves a Child: it names both aliases, the machine, the old link and the new key",
  () =>
    Effect.gen(function* () {
      const hub = yield* setup(asking);
      const asked = yield* hub.membership.move(scope, move);
      expect(asked.state).toBe("needs_human");
      expect(asked.fromLinkId).toBe(OLD);
      // The result survives the MCP schema with its continuation value.
      expect(decodeResult(asked).fromLinkId).toBe(OLD);
      const [item] = (yield* hub.inboxItems).items;
      for (const named of ["mini", "pen-mini", "env-child", OLD, PINNED])
        expect(item?.context).toContain(named);
      expect(hub.calls.some((call) => call.includes("revoke") || call.includes("link add"))).toBe(
        false,
      );
      yield* hub.approve(asked.decisionId!);
      const moved = yield* hub.membership.move(scope, { ...move, decisionId: asked.decisionId! });
      expect(moved.state).toBe("child");
      expect(hub.calls).toContain(`home link revoke --link-id ${OLD} --force --yes --json`);
      expect(hub.calls).toContain(`home link add pen-mini --expect-fingerprint ${PINNED} --json`);
      expect((yield* hub.consumed).map(({ approval_id }) => approval_id)).toEqual([
        asked.decisionId,
      ]);
    }),
);

it.effect("aliases naming different machines are refused before anything is asked or changed", () =>
  Effect.gen(function* () {
    const hub = yield* setup({ ...asking, identities: { mini: "env-a", "pen-mini": "env-b" } });
    const refused = yield* hub.membership.move(scope, move);
    expect(refused.state).toBe("failed");
    expect((yield* hub.inboxItems).items).toEqual([]);
    expect(hub.calls.some((call) => call.includes("revoke") || call.includes("link add"))).toBe(
      false,
    );
  }),
);

it.effect("a target linked while the approval waited is refused before the source is touched", () =>
  Effect.gen(function* () {
    const hub = yield* setup(asking);
    const asked = yield* hub.membership.move(scope, move);
    yield* hub.approve(asked.decisionId!);
    hub.linkAlias("pen-mini");
    const refused = yield* hub.membership.move(scope, { ...move, decisionId: asked.decisionId! });
    expect(refused.message).toContain("already linked");
    expect(hub.calls.some((call) => call.includes("revoke") || call.includes("disconnect"))).toBe(
      false,
    );
  }),
);

it.effect(
  "a failed link add keeps the approval: the same decision finishes the move once the source is gone",
  () =>
    Effect.gen(function* () {
      const hub = yield* setup({ ...asking, addFailures: 1 });
      const asked = yield* hub.membership.move(scope, move);
      yield* hub.approve(asked.decisionId!);
      const failed = yield* hub.membership.move(scope, { ...move, decisionId: asked.decisionId! });
      expect(failed.state).toBe("failed");
      expect(failed.fromLinkId).toBe(OLD);
      expect(yield* hub.consumed).toEqual([]);
      const moved = yield* hub.membership.move(scope, {
        ...move,
        decisionId: asked.decisionId!,
        fromLinkId: OLD,
        fromTunnelPort: 42255,
      });
      expect(moved.state).toBe("child");
      expect(hub.calls.filter((call) => call.startsWith("home link revoke"))).toHaveLength(1);
    }),
);

it.effect("once the source is gone, only the approved old link id continues the move", () =>
  Effect.gen(function* () {
    const hub = yield* setup({ ...asking, addFailures: 1 });
    const asked = yield* hub.membership.move(scope, move);
    yield* hub.approve(asked.decisionId!);
    yield* hub.membership.move(scope, { ...move, decisionId: asked.decisionId! });
    const tampered = yield* hub.membership
      .move(scope, {
        ...move,
        decisionId: asked.decisionId!,
        fromLinkId: "lnk_ffffffffffffffff",
        fromTunnelPort: 42255,
      })
      .pipe(Effect.flip);
    expect(tampered.message).toContain("does not approve");
    expect(hub.calls.filter((call) => call.startsWith("home link add"))).toHaveLength(1);
  }),
);

it.effect("aliases that now name another machine fail the approval", () =>
  Effect.gen(function* () {
    const identities: Record<string, string | undefined> = {};
    const hub = yield* setup({ ...asking, identities });
    const asked = yield* hub.membership.move(scope, move);
    yield* hub.approve(asked.decisionId!);
    identities.mini = "env-other";
    identities["pen-mini"] = "env-other";
    const refused = yield* hub.membership
      .move(scope, { ...move, decisionId: asked.decisionId! })
      .pipe(Effect.flip);
    expect(refused.message).toContain("does not approve");
    expect(hub.calls.some((call) => call.includes("revoke"))).toBe(false);
  }),
);

it.effect("an old tunnel that remains, or cannot be listed, stops the move before linking", () =>
  Effect.gen(function* () {
    for (const leftover of [{ strayTunnel: true }, { tunnelsUnreadable: true }]) {
      const hub = yield* setup({ ...asking, ...leftover });
      const asked = yield* hub.membership.move(scope, move);
      yield* hub.approve(asked.decisionId!);
      // The revoke lands, but the old tunnel is still running or cannot be listed.
      const first = yield* hub.membership.move(scope, { ...move, decisionId: asked.decisionId! });
      expect(first.state).toBe("failed");
      const again = yield* hub.membership.move(scope, {
        ...move,
        decisionId: asked.decisionId!,
        fromLinkId: OLD,
        fromTunnelPort: 42255,
      });
      expect(again.state).toBe("failed");
      expect(hub.calls.some((call) => call.startsWith("home link add"))).toBe(false);
      expect(yield* hub.consumed).toEqual([]);
    }
  }),
);

it.effect("an owner moves a Child with GOAT's pinned key without asking", () =>
  Effect.gen(function* () {
    const hub = yield* setup({ linked: ["mini"], pin: PINNED });
    const moved = yield* hub.membership.move(scope, move);
    expect(moved.state).toBe("child");
    expect((yield* hub.inboxItems).items).toEqual([]);
  }),
);

it.effect(
  "a continuation counts the old tunnel by its port too, so one that outlived its alias stops the move",
  () =>
    Effect.gen(function* () {
      // OpenCodex runs the old link's tunnel on port 42255; this process names another alias.
      const processes = "/usr/bin/ssh -N -R 127.0.0.1:42255:127.0.0.1:10100 -- mini-old-name";
      const hub = yield* setup({ ...asking, processes });
      const asked = yield* hub.membership.move(scope, move);
      expect(asked.fromTunnelPort).toBe(42255);
      yield* hub.approve(asked.decisionId!);
      const first = yield* hub.membership.move(scope, { ...move, decisionId: asked.decisionId! });
      expect(first.state).toBe("failed");
      const again = yield* hub.membership.move(scope, {
        ...move,
        decisionId: asked.decisionId!,
        fromLinkId: OLD,
        fromTunnelPort: 42255,
      });
      expect(again.state).toBe("failed");
      expect(hub.calls.some((call) => call.startsWith("home link add"))).toBe(false);
    }),
);

it.effect("an error after the old alias left says the old route is gone and how to continue", () =>
  Effect.gen(function* () {
    const hub = yield* setup({ ...asking, addThrows: true });
    const asked = yield* hub.membership.move(scope, move);
    yield* hub.approve(asked.decisionId!);
    const failed = yield* hub.membership.move(scope, { ...move, decisionId: asked.decisionId! });
    expect(failed.state).toBe("failed");
    expect(failed.fromLinkId).toBe(OLD);
    expect(failed.message).toContain("already left this Home");
    expect(failed.message).toContain("fromLinkId " + OLD);
  }),
);

it.effect("a thread's move continues through its handoff", () =>
  Effect.gen(function* () {
    const hub = yield* setup(asking);
    const asked = yield* hub.membership.move(threadScope, move);
    expect(asked).toMatchObject({ kind: "needs_human", next: { call: "goat_hub_device_move" } });
    yield* hub.answer(asked.decisionId!);
    const moved = yield* hub.membership.move(threadScope, {
      ...move,
      decisionId: asked.decisionId!,
    });
    expect(moved.state).toBe("child");
  }),
);

it.effect("a link record without a tunnel port is refused before the old alias is touched", () =>
  Effect.gen(function* () {
    const hub = yield* setup({ ...asking, noTunnelPort: true });
    const refused = yield* hub.membership.move(scope, move);
    expect(refused.state).toBe("failed");
    expect(refused.message).toContain("tunnel port");
    expect((yield* hub.inboxItems).items).toEqual([]);
    expect(hub.calls.some((call) => call.includes("revoke") || call.includes("disconnect"))).toBe(
      false,
    );
  }),
);

it.effect(
  "an error right after the revoke says the old alias already left and how to continue",
  () =>
    Effect.gen(function* () {
      const hub = yield* setup({ ...asking, statusFailsAfterRevoke: true });
      const asked = yield* hub.membership.move(scope, move);
      yield* hub.approve(asked.decisionId!);
      const failed = yield* hub.membership.move(scope, { ...move, decisionId: asked.decisionId! });
      expect(failed.state).toBe("failed");
      expect(failed.message).toContain("already left this Home");
      expect(failed.message).toContain("fromTunnelPort 42255");
    }),
);

it.effect("a stop after the old link is gone still says so and how to continue", () =>
  Effect.gen(function* () {
    const hub = yield* setup({ ...asking, linked: [], direct: false });
    const stopped = yield* hub.membership.move(scope, {
      ...move,
      decisionId: "decision:earlier",
      fromLinkId: OLD,
      fromTunnelPort: 42255,
    });
    expect(stopped.state).toBe("failed");
    expect(stopped.message).toContain("already left this Home");
  }),
);
