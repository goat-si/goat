import { expect, it } from "@effect/vitest";
import { HubDeviceMcpResult } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Statement from "effect/sql/Statement";

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
      for (const named of ["mini", "pen-mini", "env-child", OLD, "port 42255", PINNED])
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
      expect(failed.message).toContain("no longer routes through it");
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

it.effect(
  "an old tunnel that remains, or cannot be listed, stops the move and leaves routing unproven",
  () =>
    Effect.gen(function* () {
      for (const leftover of [{ strayTunnel: true }, { tunnelsUnreadable: true }]) {
        const hub = yield* setup({ ...asking, ...leftover });
        const asked = yield* hub.membership.move(scope, move);
        yield* hub.approve(asked.decisionId!);
        // The revoke lands, but the old tunnel is still running or cannot be listed.
        const first = yield* hub.membership.move(scope, { ...move, decisionId: asked.decisionId! });
        expect(first.state).toBe("failed");
        expect(first.message).toContain("unproven");
        expect(first.message).not.toContain("no longer routes");
        const again = yield* hub.membership.move(scope, {
          ...move,
          decisionId: asked.decisionId!,
          fromLinkId: OLD,
          fromTunnelPort: 42255,
        });
        expect(again.state).toBe("failed");
        expect(again.message).toContain("unproven");
        expect(again.message).not.toContain("no longer routes");
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
    expect(failed.message).toContain("no longer routes through it");
    expect(failed.message).toContain("fromLinkId " + OLD);
  }),
);

it.effect("a thread's move continues through its handoff", () =>
  Effect.gen(function* () {
    const hub = yield* setup(asking);
    const asked = yield* hub.membership.move(threadScope, move);
    expect(asked).toMatchObject({ kind: "needs_human", next: { call: "goat_hub_device_move" } });
    // The person sees the old tunnel port the approval binds, as on the inbox path.
    expect(hub.handoffReason(asked.decisionId!)).toContain("port 42255");
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
  "an error right after the revoke says the old link was revoked, routing is unproven, and how to continue",
  () =>
    Effect.gen(function* () {
      const hub = yield* setup({ ...asking, statusFailsAfterRevoke: true });
      const asked = yield* hub.membership.move(scope, move);
      yield* hub.approve(asked.decisionId!);
      const failed = yield* hub.membership.move(scope, { ...move, decisionId: asked.decisionId! });
      expect(failed.state).toBe("failed");
      expect(failed.message).toContain("revoked");
      expect(failed.message).toContain("unproven");
      expect(failed.message).toContain("fromTunnelPort 42255");
    }),
);

it.effect("a stop after the old link is gone still says so and how to continue", () =>
  Effect.gen(function* () {
    const hub = yield* setup({ ...asking, addFailures: 1 });
    const asked = yield* hub.membership.move(scope, move);
    yield* hub.approve(asked.decisionId!);
    // The first attempt leaves the old alias, then its link add is refused.
    yield* hub.membership.move(scope, { ...move, decisionId: asked.decisionId! });
    hub.setDirect(false);
    const stopped = yield* hub.membership.move(scope, {
      ...move,
      decisionId: asked.decisionId!,
      fromLinkId: OLD,
      fromTunnelPort: 42255,
    });
    expect(stopped.state).toBe("failed");
    // This call stopped before rechecking the old tunnel, so it does not claim routing stopped,
    // and it saw only an absent record, not a revoke of its own.
    expect(stopped.message).toContain("unproven");
    expect(stopped.message).toContain("no link record for mini");
    expect(stopped.message).not.toContain("revoked");
    expect(stopped.message).toContain("fromTunnelPort 42255");
  }),
);

it.effect("a failed audit write after an unclean revoke still returns the partial move", () =>
  Effect.gen(function* () {
    const hub = yield* setup({ ...asking, strayTunnel: true });
    const asked = yield* hub.membership.move(scope, move);
    yield* hub.approve(asked.decisionId!);
    yield* hub.sql`CREATE TRIGGER audit_full BEFORE INSERT ON audit_events WHEN NEW.outcome = 'failed'
      BEGIN SELECT RAISE(ABORT, 'audit disk full'); END`;
    const failed = yield* hub.membership.move(scope, { ...move, decisionId: asked.decisionId! });
    expect(failed.state).toBe("failed");
    expect(failed.fromLinkId).toBe(OLD);
    expect(failed.message).toContain("unproven");
    expect(failed.message).toContain("fromLinkId " + OLD);
  }),
);

it.effect(
  "a link added before its approval could be recorded is reported as linked, not retried",
  () =>
    Effect.gen(function* () {
      const hub = yield* setup(asking);
      const asked = yield* hub.membership.move(scope, move);
      yield* hub.approve(asked.decisionId!);
      yield* hub.sql`CREATE TRIGGER used_full BEFORE INSERT ON approval_consumptions
        BEGIN SELECT RAISE(ABORT, 'approval store full'); END`;
      const added = yield* hub.membership.move(scope, { ...move, decisionId: asked.decisionId! });
      expect(added.state).toBe("degraded");
      expect(added.message).toContain("pen-mini was linked to this Home");
      expect(added.message).toContain("goat_hub_device_verify");
      expect(added.message).not.toContain("Call goat_hub_device_move again");
      expect(added.fromLinkId).toBeUndefined();
      // The target-first check refuses a second add with the same, still unspent, approval.
      const again = yield* hub.membership.move(scope, { ...move, decisionId: asked.decisionId! });
      expect(again.message).toContain("already linked");
      expect(hub.calls.filter((call) => call.startsWith("home link add"))).toHaveLength(1);
    }),
);

/** Runs a move as a caller would; `stop` ends that caller the way a cancel or dropped request does. */
const startMove = (hub: Effect.Success<ReturnType<typeof setup>>, input: typeof move) =>
  Effect.gen(function* () {
    const fiber = yield* hub.membership
      .move(scope, input)
      .pipe(Effect.forkChild({ startImmediately: true }));
    return { stop: Fiber.interrupt(fiber) };
  });
// The next membership change waits on the permit a running move holds until it finishes.
const afterMoves = (hub: Effect.Success<ReturnType<typeof setup>>) =>
  Effect.exit(hub.membership.move(scope, { fromAlias: "not an alias", toAlias: "x" }));

it.effect("a move whose caller stops after the old link is revoked still links the new alias", () =>
  Effect.gen(function* () {
    const revoked = yield* Deferred.make<void>();
    const gate = yield* Deferred.make<void>();
    const hub = yield* setup({
      linked: ["mini"],
      pin: PINNED,
      afterRevoke: Deferred.succeed(revoked, undefined).pipe(Effect.andThen(Deferred.await(gate))),
    });
    const moving = yield* startMove(hub, move);
    yield* Deferred.await(revoked);
    // The caller is gone here, with the device routing through no hub.
    yield* moving.stop;
    yield* Deferred.succeed(gate, undefined);
    yield* afterMoves(hub);
    expect(hub.calls).toContain(`home link add pen-mini --expect-fingerprint ${PINNED} --json`);
    expect((yield* hub.audit).filter(({ action }) => action === "hub.move").at(-1)).toMatchObject({
      target: "pen-mini",
      outcome: "child",
    });
  }),
);

// A move that would ask an owner first, and an owner's move with the pinned key that would not.
const profiles = {
  "asking an owner": asking,
  "an owner's pinned move": { linked: ["mini"], pin: PINNED },
};
it.effect.each(["asking an owner", "an owner's pinned move"] as const)(
  "a move whose caller stops before routing changes (%s) is refused, moves nothing and asks no one",
  (profile) =>
    Effect.gen(function* () {
      const probing = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const hub = yield* setup({
        ...profiles[profile],
        duringProbe: Deferred.succeed(probing, undefined).pipe(
          Effect.andThen(Deferred.await(gate)),
        ),
      });
      const moving = yield* startMove(hub, move);
      yield* Deferred.await(probing);
      yield* moving.stop;
      yield* Deferred.succeed(gate, undefined);
      yield* afterMoves(hub);
      expect(hub.calls.filter((call) => /revoke|disconnect|link add/.test(call))).toEqual([]);
      expect((yield* hub.inboxItems).items).toEqual([]);
      expect(
        (yield* hub.audit).filter(
          ({ action, target }) => action === "hub.move" && target === "pen-mini",
        ),
      ).toEqual([]);
    }),
);

it.effect("a move whose caller stops while GOAT reads the pinned key asks no one", () =>
  Effect.gen(function* () {
    const reading = yield* Deferred.make<void>();
    const gate = yield* Deferred.make<void>();
    const hub = yield* setup({
      ...asking,
      duringPin: Deferred.succeed(reading, undefined).pipe(Effect.andThen(Deferred.await(gate))),
    });
    const moving = yield* startMove(hub, move);
    yield* Deferred.await(reading);
    yield* moving.stop;
    yield* Deferred.succeed(gate, undefined);
    yield* afterMoves(hub);
    expect((yield* hub.inboxItems).items).toEqual([]);
    expect(hub.calls.filter((call) => /revoke|disconnect|link add/.test(call))).toEqual([]);
  }),
);

it.effect("a move whose caller stops while its start is audited leaves the old link alone", () =>
  Effect.gen(function* () {
    const auditing = yield* Deferred.make<void>();
    const gate = yield* Deferred.make<void>();
    // Holds the "started" audit row's insert until the caller has gone.
    const holdStarted: Statement.Transformer = (statement) => {
      const [query, params] = statement.compile();
      return query.includes("INSERT INTO audit_events") && params.includes("started")
        ? Deferred.succeed(auditing, undefined).pipe(
            Effect.andThen(Deferred.await(gate)),
            Effect.as(statement),
          )
        : Effect.succeed(statement);
    };
    const hub = yield* setup({ linked: ["mini"], pin: PINNED });
    const moving = yield* startMove(hub, move).pipe(
      Effect.provideService(Statement.CurrentTransformer, holdStarted),
    );
    yield* Deferred.await(auditing);
    yield* moving.stop;
    yield* Deferred.succeed(gate, undefined);
    yield* afterMoves(hub);
    expect(hub.calls.filter((call) => /revoke|disconnect|link add/.test(call))).toEqual([]);
    expect(
      (yield* hub.audit)
        .filter(({ action, target }) => action === "hub.move" && target === "pen-mini")
        .map(({ outcome }) => outcome),
    ).toEqual(["started", "failed"]);
  }),
);
