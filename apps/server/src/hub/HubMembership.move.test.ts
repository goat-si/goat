import { expect, it } from "@effect/vitest";
import { HubDeviceMcpResult } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { PINNED, scope, setup } from "./HubMembership.testkit.ts";

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
    const linked = yield* setup({ ...asking, linked: ["mini", "pen-mini"] });
    const refused = yield* linked.membership.move(scope, move);
    expect(refused.message).toContain("already linked");
    expect(linked.calls.some((call) => call.includes("revoke"))).toBe(false);
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
      .move(scope, { ...move, decisionId: asked.decisionId!, fromLinkId: "lnk_ffffffffffffffff" })
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
