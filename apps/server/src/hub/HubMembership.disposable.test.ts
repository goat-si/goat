import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { DisposableRecord } from "./disposable/disposableClass.ts";
import { OTHER, PINNED, scope, setup } from "./HubMembership.testkit.ts";

// Design section 6: a disposable machine is reached only through its own Pen route, so no
// kept-machine path links it under another alias or moves it to one.
const node = "c".repeat(26);
const record = (overrides: Partial<DisposableRecord> = {}): DisposableRecord => ({
  attachId: "attach-1",
  nodeId: node,
  state: "linked",
  stateSince: "2026-11-14T00:00:00.000Z",
  createdAt: "2026-11-14T00:00:00.000Z",
  provisioner: { kind: "person" },
  final: false,
  environmentId: "env-disposable",
  machineInstallId: null,
  sshdPin: PINNED,
  linkId: null,
  conflicts: [],
  penMember: true,
  ...overrides,
});
const changed = (calls: ReadonlyArray<string>) =>
  calls.some((call) => call.includes("link add") || call.includes("revoke"));

it.effect(
  "hub.device_join refuses a disposable machine by its Pen alias or the key it offers, before any approval or link",
  () =>
    Effect.gen(function* () {
      const hub = yield* setup({ disposable: [record()] });
      for (const deviceAlias of ["pen-" + node, "mini"]) {
        const refused = yield* hub.membership.join(scope, { deviceAlias });
        expect(refused.state).toBe("failed");
        expect(refused.message).toContain("disposable machine");
      }
      expect((yield* hub.inboxItems).items).toEqual([]);
      expect(changed(hub.calls)).toBe(false);
    }),
);

it.effect("an ended record or another machine's key leaves hub.device_join as it was", () =>
  Effect.gen(function* () {
    const ended = yield* setup({ disposable: [record({ final: true })] });
    expect((yield* ended.membership.join(scope, { deviceAlias: "mini" })).message).not.toContain(
      "disposable machine",
    );
    const other = yield* setup({ disposable: [record({ sshdPin: OTHER })] });
    expect((yield* other.membership.join(scope, { deviceAlias: "mini" })).message).not.toContain(
      "disposable machine",
    );
  }),
);

it.effect(
  "hub.device_move to an alias that offers a disposable machine's key is refused before anything is asked",
  () =>
    Effect.gen(function* () {
      const hub = yield* setup({ profile: "hub-admin", linked: ["mini"], disposable: [record()] });
      const refused = yield* hub.membership.move(scope, { fromAlias: "mini", toAlias: "pen-mini" });
      expect(refused.state).toBe("failed");
      expect(refused.message).toContain("disposable machine");
      expect((yield* hub.inboxItems).items).toEqual([]);
      expect(changed(hub.calls)).toBe(false);
    }),
);

it.effect(
  "a Hub-client join refuses a disposable machine by its Pen alias or the GOAT it runs, before any approval or invite",
  () =>
    Effect.gen(function* () {
      const hub = yield* setup({
        disposable: [record()],
        identities: { lab: "env-disposable" },
      });
      for (const deviceAlias of ["pen-" + node, "lab"]) {
        const refused = yield* hub.membership.join(scope, { deviceAlias, transport: "hub-client" });
        expect(refused.state).toBe("failed");
        expect(refused.message).toContain("disposable machine");
      }
      expect((yield* hub.inboxItems).items).toEqual([]);
      expect(hub.calls.some((call) => call.startsWith("handoff"))).toBe(false);
    }),
);

it.effect(
  "hub.device_move refuses a disposable source by its Pen alias alone, and either alias by the GOAT it runs, before anything is asked",
  () =>
    Effect.gen(function* () {
      const bySource = yield* setup({
        profile: "hub-admin",
        linked: ["pen-" + node],
        offered: OTHER,
        disposable: [record()],
      });
      const fromPen = yield* bySource.membership.move(scope, {
        fromAlias: "pen-" + node,
        toAlias: "mini",
      });
      expect(fromPen.message).toContain("disposable machine");
      const byEnvironment = yield* setup({
        profile: "hub-admin",
        linked: ["mini"],
        offered: OTHER,
        identities: { mini: "env-disposable", "mini-direct": "env-disposable" },
        disposable: [record()],
      });
      const sameMachine = yield* byEnvironment.membership.move(scope, {
        fromAlias: "mini",
        toAlias: "mini-direct",
      });
      expect(sameMachine.message).toContain("disposable machine");
      for (const hub of [bySource, byEnvironment]) {
        expect((yield* hub.inboxItems).items).toEqual([]);
        expect(changed(hub.calls)).toBe(false);
      }
    }),
);

it.effect(
  "an offline disposable alias is refused by its name before OpenCodex's probe answers",
  () =>
    Effect.gen(function* () {
      const hub = yield* setup({ disposable: [record()], deviceDown: ["pen-" + node] });
      const refused = yield* hub.membership.join(scope, { deviceAlias: "pen-" + node });
      expect(refused.message).toContain("disposable machine");
      expect(hub.calls.some((call) => call.includes("link probe"))).toBe(false);
    }),
);

it.effect(
  "hub.device_repair's re-link refuses a disposable machine's key before the old link is touched",
  () =>
    Effect.gen(function* () {
      const hub = yield* setup({ linked: ["mini"], disposable: [record()] });
      const refused = yield* hub.membership.repair(scope, {
        deviceAlias: "mini",
        decisionId: "decision-1",
      });
      expect(refused.state).toBe("failed");
      expect(refused.message).toContain("disposable machine");
      expect(changed(hub.calls)).toBe(false);
    }),
);
