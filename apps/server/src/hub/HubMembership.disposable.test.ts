import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { DisposableRecord } from "./disposable/disposableClass.ts";
import { OTHER, PINNED, scope, setup, verdict } from "./HubMembership.testkit.ts";

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

const KEY = "AAAAC3NzaC1lZDI1NTE5AAAAIJqQutSw0XQo7KOx5R7x4wcb2s6h3WPkcz2z6WIeJ3Re";
const penLine = (name: string, nodeId: string) => `pen-${name},pen-${nodeId} ssh-ed25519 ${KEY}\n`;

it.effect(
  "Pen's own pen-<name> for a disposable machine with no pin and no environment yet is refused on either join transport, offline",
  () =>
    Effect.gen(function* () {
      for (const transport of ["remote-link", "hub-client"] as const) {
        const hub = yield* setup({
          disposable: [record({ sshdPin: null, environmentId: null })],
          penKnownHosts: penLine("cc-07", node),
        });
        const refused = yield* hub.membership.join(scope, { deviceAlias: "pen-cc-07", transport });
        expect(refused.state).toBe("failed");
        expect(refused.message).toContain("disposable machine");
        expect(hub.calls.some((call) => call.includes("probe") || call.includes("identify"))).toBe(
          false,
        );
        expect(changed(hub.calls)).toBe(false);
      }
    }),
);

it.effect("a kept member's pen-<name> joins as before", () =>
  Effect.gen(function* () {
    const hub = yield* setup({
      disposable: [record({ sshdPin: null, environmentId: null })],
      penKnownHosts: penLine("cc-09", "d".repeat(26)),
    });
    const joined = yield* hub.membership.join(scope, { deviceAlias: "pen-cc-09" });
    expect(joined.message).not.toContain("disposable machine");
  }),
);

it.effect(
  "a Hub-client join compares the ED25519 key the alias offers, since it has no OpenCodex probe",
  () =>
    Effect.gen(function* () {
      const pinned = yield* setup({
        disposable: [record({ environmentId: null })],
        identities: { lab: "env-kept" },
        hostKeys: { lab: PINNED },
      });
      const refused = yield* pinned.membership.join(scope, {
        deviceAlias: "lab",
        transport: "hub-client",
      });
      expect(refused.message).toContain("SSH host key it offered");
      expect((yield* pinned.inboxItems).items).toEqual([]);
      const other = yield* setup({
        disposable: [record({ environmentId: null })],
        identities: { lab: "env-kept" },
        hostKeys: { lab: OTHER },
      });
      const kept = yield* other.membership.join(scope, {
        deviceAlias: "lab",
        transport: "hub-client",
      });
      expect(kept.message).not.toContain("disposable machine");
    }),
);

it.effect(
  "an OpenCodex probe key of another type than ED25519 is not compared with an ED25519 pin",
  () =>
    Effect.gen(function* () {
      const hub = yield* setup({
        disposable: [record({ environmentId: null })],
        offeredKeyType: "ecdsa-sha2-nistp256",
      });
      const joined = yield* hub.membership.join(scope, { deviceAlias: "mini" });
      expect(joined.message).not.toContain("disposable machine");
    }),
);

it.effect("no GOAT is identified while no open record has an environment to compare it with", () =>
  Effect.gen(function* () {
    const hub = yield* setup({ disposable: [record({ environmentId: null, sshdPin: null })] });
    yield* hub.membership.join(scope, { deviceAlias: "mini", transport: "hub-client" });
    expect(hub.calls.some((call) => call.startsWith("identify"))).toBe(false);
  }),
);

// Leave and repair would change a disposable machine's own link outside detach.
const LINK = "lnk_0123456789abcdef";
const onlyRead = (calls: ReadonlyArray<string>) =>
  calls.every((call) => call === "home link status --json");
const OWN = [
  { alias: "pen-" + node, own: record() },
  { alias: "mini", own: record({ linkId: LINK }) },
];

it.effect(
  "hub.device_leave refuses an open disposable machine by its Pen alias or its link id, before consent, device calls or a revoke",
  () =>
    Effect.gen(function* () {
      for (const { alias, own } of OWN) {
        for (const decisionId of [undefined, "decision-1"]) {
          const hub = yield* setup({ linked: [alias], disposable: [own] });
          const refused = yield* hub.membership.leave(scope, {
            deviceAlias: alias,
            ...(decisionId === undefined ? {} : { decisionId }),
          });
          expect(refused.state).toBe("failed");
          expect(refused.message).toContain("Detach it in Settings → Hub on web or desktop");
          expect((yield* hub.inboxItems).items).toEqual([]);
          expect(onlyRead(hub.calls)).toBe(true);
        }
      }
    }),
);

it.effect(
  "hub.device_repair refuses the whole ladder for an open disposable machine, since OpenCodex brings its tunnel back itself",
  () =>
    Effect.gen(function* () {
      for (const { alias, own } of OWN) {
        for (const decisionId of [undefined, "decision-1"]) {
          const hub = yield* setup({
            linked: [alias],
            disposable: [own],
            verdicts: [verdict(["P2"])],
          });
          const refused = yield* hub.membership.repair(scope, {
            deviceAlias: alias,
            ...(decisionId === undefined ? {} : { decisionId }),
          });
          expect(refused.state).toBe("failed");
          expect(refused.message).toContain("OpenCodex retries");
          expect(refused.message).toContain("Detach it in Settings → Hub on web or desktop");
          expect((yield* hub.inboxItems).items).toEqual([]);
          expect(onlyRead(hub.calls)).toBe(true);
        }
      }
    }),
);

it.effect(
  "an unreadable or forbidden Home link status still refuses leave and repair by the Pen alias, before any device read",
  () =>
    Effect.gen(function* () {
      for (const linkStatus of ["forbidden", "failed"] as const) {
        for (const decisionId of [undefined, "decision-1"]) {
          for (const action of ["leave", "repair"] as const) {
            const hub = yield* setup({ linkStatus, disposable: [record()] });
            const input = {
              deviceAlias: "pen-" + node,
              ...(decisionId === undefined ? {} : { decisionId }),
            };
            const refused =
              action === "leave"
                ? yield* hub.membership.leave(scope, input)
                : yield* hub.membership.repair(scope, input);
            expect(refused.state).toBe("failed");
            expect(refused.message).toContain("Detach it in Settings → Hub on web or desktop");
            expect((yield* hub.inboxItems).items).toEqual([]);
            expect(onlyRead(hub.calls)).toBe(true);
          }
        }
      }
    }),
);

it.effect("a twin Pen name is refused by the record's own link id", () =>
  Effect.gen(function* () {
    const twin = penLine("cc-07", node) + penLine("cc-07", "d".repeat(26));
    for (const action of ["leave", "repair"] as const) {
      const hub = yield* setup({
        linked: ["pen-cc-07"],
        penKnownHosts: twin,
        disposable: [record({ linkId: LINK })],
      });
      const refused =
        action === "leave"
          ? yield* hub.membership.leave(scope, { deviceAlias: "pen-cc-07" })
          : yield* hub.membership.repair(scope, { deviceAlias: "pen-cc-07" });
      expect(refused.message).toContain("matched by its OpenCodex link");
      expect(onlyRead(hub.calls)).toBe(true);
    }
  }),
);

it.effect(
  "an ended record, a kept Pen member and a twin Pen name on another link leave hub.device_leave and repair as they were",
  () =>
    Effect.gen(function* () {
      const other = "d".repeat(26);
      const fixtures = [
        { alias: "pen-" + node, disposable: [record({ final: true, linkId: LINK })] },
        {
          alias: "pen-cc-09",
          disposable: [record({ linkId: "lnk_aaaaaaaaaaaaaaaa" })],
          penKnownHosts: penLine("cc-09", other),
        },
        {
          alias: "pen-cc-07",
          disposable: [record({ linkId: "lnk_aaaaaaaaaaaaaaaa" })],
          penKnownHosts: penLine("cc-07", node) + penLine("cc-07", other),
        },
      ];
      for (const { alias, ...fixture } of fixtures) {
        const left = yield* setup({ linked: [alias], ...fixture });
        expect((yield* left.membership.leave(scope, { deviceAlias: alias })).state).toBe("ready");
        const repaired = yield* setup({
          linked: [alias],
          verdicts: [verdict(["P6"]), verdict()],
          ...fixture,
        });
        expect((yield* repaired.membership.repair(scope, { deviceAlias: alias })).state).toBe(
          "child",
        );
      }
    }),
);
