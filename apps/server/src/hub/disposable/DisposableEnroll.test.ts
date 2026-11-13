import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { penNodeId } from "./attachModel.ts";
import * as Attach from "./DisposableAttach.ts";
import { attach, key, listed, rows, switchTo, world } from "./DisposableAttach.testkit.ts";
import {
  MACHINE_KEY_FILE,
  MACHINE_KEY_LINE,
  makeHold,
  penRouteOf,
} from "./DisposableEnroll.testkit.ts";
import { LINK_CONTRACTS, LINK_IDENTITY_CONTRACT } from "./enrollModel.ts";
import { HOME_ATTACH_CONTRACTS } from "./features.ts";

const enroll = Effect.flatMap(Attach.DisposableAttach, (service) => service.enroll);
const HOUR = 60 * 60 * 1000;

/** Attach machine n, let it join Pen with its keys, and settle the admission. */
const joined = (
  pen: Parameters<Parameters<typeof world>[0]>[0],
  host: Parameters<Parameters<typeof world>[0]>[3],
  n: number,
) =>
  Effect.gen(function* () {
    const started = yield* attach(n);
    pen.control.join(started.attachId + ".1", true);
    const nodeId = penNodeId(key(n)) ?? "";
    host.control.routes.set(
      nodeId,
      penRouteOf({ nodeId, noisePub: key(100 + n) }, "ssh-ed25519 " + String(n).repeat(68)),
    );
    // A list of one attach settles it without starting an enrollment pass; tests run each pass.
    yield* listed(started.attachId);
    return { attachId: started.attachId, nodeId, started };
  });
const linkAdds = (calls: ReadonlyArray<ReadonlyArray<string>>) =>
  calls.filter((args) => args[1] === "add");
const withIdentity = (home: { contracts: Set<string> }) => {
  home.contracts = new Set([...HOME_ATTACH_CONTRACTS, ...LINK_CONTRACTS, LINK_IDENTITY_CONTRACT]);
};

it.effect(
  "an admitted machine is reached with the hub key and linked as an exclusive lightweight Child under an operation id",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        withIdentity(home);
        const { attachId, nodeId, started } = yield* joined(pen, host, 1);
        // The provisioner learns the one key the machine must trust in the first answer.
        expect(started.machineKey).toBe(MACHINE_KEY_LINE);
        yield* enroll; // route
        yield* enroll; // reach
        yield* enroll; // link
        yield* enroll; // verify
        const route = penRouteOf({ nodeId, noisePub: key(101) }, "ssh-ed25519 " + "1".repeat(68));
        expect(host.control.reached).toEqual([
          {
            nodeId,
            noisePub: key(101),
            proxyCommand: route.proxyCommand,
            user: "runner",
            knownHostsFile: "/srv/goat/disposable/known_hosts/" + attachId,
            identityFile: MACHINE_KEY_FILE,
          },
        ]);
        expect(host.control.knownHosts.get(attachId)).toBe(
          "pen-" + nodeId + " " + route.hostKey + "\n",
        );
        expect(linkAdds(host.control.calls)).toEqual([
          [
            "link",
            "add",
            "pen-" + nodeId,
            "--plant",
            "--require-ephemeral",
            "--expect-fingerprint",
            route.fingerprint,
            "--operation-id",
            attachId + ".link.1",
            "--proxy-command",
            route.proxyCommand,
            "--ssh-user",
            "runner",
            "--ssh-port",
            "22",
            "--exclusive",
            "--ssh-identity-file",
            MACHINE_KEY_FILE,
            "--json",
          ],
        ]);
        const machine = yield* listed(attachId);
        expect(machine).toMatchObject({ state: "linked", step: "linked", class: "disposable" });
        expect(machine?.steps.map((entry) => entry.step + ":" + entry.outcome)).toEqual([
          "invite:burned",
          "route:ok",
          "reach:ok",
          "link:ok",
        ]);
        const [row] = yield* rows;
        expect(row).toMatchObject({ link_id: "lnk_0000000000000001", sshd_pin: route.fingerprint });
      }),
    ),
);

it.effect("a machine that does not answer the hub key waits at reach and links nothing", () =>
  world((pen, home, _grant, host) =>
    Effect.gen(function* () {
      withIdentity(home);
      const { attachId, nodeId } = yield* joined(pen, host, 1);
      host.control.unreachable.add(nodeId);
      yield* enroll;
      yield* enroll;
      yield* enroll;
      expect(yield* listed(attachId)).toMatchObject({ state: "attaching", step: "reach" });
      expect(linkAdds(host.control.calls)).toEqual([]);
      host.control.unreachable.delete(nodeId);
      yield* enroll;
      yield* enroll;
      yield* enroll;
      expect(yield* listed(attachId)).toMatchObject({ state: "linked" });
    }),
  ),
);

it.effect(
  "a Home that cannot link with the hub key is never asked to link; the attach waits for it",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const { attachId } = yield* joined(pen, host, 1);
        yield* enroll;
        yield* enroll;
        yield* enroll;
        expect(linkAdds(host.control.calls)).toEqual([]);
        // No OpenCodex release takes a key with the route yet, so an update cannot help.
        const waiting = yield* listed(attachId);
        expect(waiting).toMatchObject({ state: "attaching" });
        expect(waiting?.message).toContain("No OpenCodex release");
        expect(waiting?.message).not.toContain("update OpenCodex");
        // A Home older than explicit routes is told to update.
        home.contracts = new Set(["link.operation/1", "link.recover/1"]);
        yield* enroll;
        expect(yield* listed(attachId)).toMatchObject({
          message: expect.stringContaining("update OpenCodex"),
        });
        expect(linkAdds(host.control.calls)).toEqual([]);
      }),
    ),
);

it.effect("a lost link answer is settled from OpenCodex's journal and never sent again", () =>
  world((pen, home, _grant, host) =>
    Effect.gen(function* () {
      withIdentity(home);
      const { attachId } = yield* joined(pen, host, 1);
      host.control.adds.push("commit_lost");
      for (let pass = 0; pass < 5; pass += 1) yield* enroll;
      expect(linkAdds(host.control.calls)).toHaveLength(1);
      expect(yield* listed(attachId)).toMatchObject({ state: "linked" });
    }),
  ),
);

it.effect(
  "an id OpenCodex never journalled is sent again only within the 2 hours it keeps every entry",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        withIdentity(home);
        const first = yield* joined(pen, host, 1);
        host.control.adds.push("not_journalled", "not_journalled");
        yield* enroll;
        yield* enroll;
        yield* enroll; // sent, never journalled
        yield* enroll; // read back: not found within 2 hours, so the same id goes again
        expect(linkAdds(host.control.calls).map((args) => args[8])).toEqual([
          first.attachId + ".link.1",
          first.attachId + ".link.1",
        ]);
        // Past the window the journal may have dropped a settled entry: the id proves nothing.
        yield* TestClock.adjust(2 * HOUR);
        yield* enroll;
        expect(linkAdds(host.control.calls)).toHaveLength(2);
        expect(yield* listed(first.attachId)).toMatchObject({
          state: "unknown",
          message: expect.stringContaining("more than two hours ago"),
        });
      }),
    ),
);

it.effect("a pruned entry of a committed link is never resent after 2 hours", () =>
  world((pen, home, _grant, host) =>
    Effect.gen(function* () {
      withIdentity(home);
      const { attachId } = yield* joined(pen, host, 1);
      host.control.adds.push("commit_lost");
      yield* enroll;
      yield* enroll;
      const sql = yield* SqlClient.SqlClient;
      host.control.statusUnreadable = true;
      yield* enroll; // sent and committed; the answer is lost and the journal read after it
      expect(linkAdds(host.control.calls)).toHaveLength(1);
      // Forget the stored link id, as a crash between the journal read and its save would leave.
      yield* sql`UPDATE disposable_machines SET link_id = NULL WHERE attach_id = ${attachId}`;
      host.control.forget(attachId + ".link.1");
      yield* TestClock.adjust(2 * HOUR);
      yield* enroll;
      expect(linkAdds(host.control.calls)).toHaveLength(1);
      expect(yield* listed(attachId)).toMatchObject({ state: "unknown" });
    }),
  ),
);

it.effect("a full OpenCodex install on the machine stops the attach; nothing retries it", () =>
  world((pen, home, _grant, host) =>
    Effect.gen(function* () {
      withIdentity(home);
      const { attachId } = yield* joined(pen, host, 1);
      host.control.adds.push({ failedClean: "full_install_present" });
      for (let pass = 0; pass < 5; pass += 1) yield* enroll;
      expect(linkAdds(host.control.calls)).toHaveLength(1);
      expect(yield* listed(attachId)).toMatchObject({
        state: "paused",
        penMember: true,
        message: expect.stringContaining("full OpenCodex install"),
      });
    }),
  ),
);

it.effect(
  "a failed link starts a new operation id, up to three; residual holds the record unknown",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        withIdentity(home);
        const first = yield* joined(pen, host, 1);
        host.control.adds.push(
          { failedClean: "child_port_busy" },
          { failedClean: "child_port_busy" },
          { failedClean: "child_port_busy" },
        );
        for (let pass = 0; pass < 8; pass += 1) yield* enroll;
        expect(linkAdds(host.control.calls).map((args) => args[8])).toEqual([
          first.attachId + ".link.1",
          first.attachId + ".link.2",
          first.attachId + ".link.3",
        ]);
        expect(yield* listed(first.attachId)).toMatchObject({ state: "paused" });
        const second = yield* joined(pen, host, 2);
        host.control.adds.push("residual");
        for (let pass = 0; pass < 4; pass += 1) yield* enroll;
        expect(yield* listed(second.attachId)).toMatchObject({
          state: "unknown",
          penMember: true,
        });
      }),
    ),
);

it.effect(
  "two machines with one sshd key, or a key Pen changes later, are conflicts and nothing links",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        withIdentity(home);
        const first = yield* joined(pen, host, 1);
        yield* enroll;
        // A clone of the first machine, with its sshd keys.
        const second = yield* joined(pen, host, 2);
        host.control.routes.set(
          second.nodeId,
          penRouteOf(
            { nodeId: second.nodeId, noisePub: key(102) },
            "ssh-ed25519 " + "1".repeat(68),
          ),
        );
        yield* enroll; // the first reaches; the second's route meets the first's pin
        expect(yield* listed(second.attachId)).toMatchObject({
          class: "conflict",
          state: "paused",
        });
        // Pen now advertises another key for the first machine before its link.
        host.control.routes.set(
          first.nodeId,
          penRouteOf({ nodeId: first.nodeId, noisePub: key(101) }, "ssh-ed25519 " + "Z".repeat(68)),
        );
        yield* enroll;
        expect(yield* listed(first.attachId)).toMatchObject({ class: "conflict", state: "paused" });
        expect(linkAdds(host.control.calls)).toEqual([]);
      }),
    ),
);

it.effect(
  "with the switch turned off before the link, the attach pauses and ocx is not asked",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        withIdentity(home);
        const { attachId } = yield* joined(pen, host, 1);
        yield* enroll;
        yield* enroll;
        yield* switchTo({ enabled: false });
        yield* enroll;
        expect(linkAdds(host.control.calls)).toEqual([]);
        expect(yield* listed(attachId)).toMatchObject({ state: "paused", penMember: true });
        // Turning it on again is a new grant; the paused attach stays for a person.
        yield* switchTo({ enabled: true });
        yield* enroll;
        expect(linkAdds(host.control.calls)).toEqual([]);
      }),
    ),
);

it.effect("an unreadable settings read pauses nothing and moves nothing on", () =>
  world((pen, home, _grant, host) =>
    Effect.gen(function* () {
      withIdentity(home);
      const { attachId } = yield* joined(pen, host, 1);
      home.settingsUnreadable = true;
      yield* enroll;
      home.settingsUnreadable = false;
      expect(yield* listed(attachId)).toMatchObject({ state: "admitted" });
      expect(host.control.knownHosts.size).toBe(0);
    }),
  ),
);

it.effect("authority withdrawn while a stored id is read back stops the resend before ocx", () =>
  world((pen, home, _grant, host) =>
    Effect.gen(function* () {
      withIdentity(home);
      const { attachId } = yield* joined(pen, host, 1);
      host.control.adds.push("not_journalled");
      yield* enroll;
      yield* enroll;
      yield* enroll; // sent, never journalled
      const hold = yield* makeHold();
      host.control.holdOperations = hold;
      const pass = yield* Effect.forkChild(enroll);
      yield* Deferred.await(hold.arrived);
      yield* switchTo({ enabled: false });
      yield* Deferred.succeed(hold.release, undefined);
      yield* Fiber.join(pass);
      expect(linkAdds(host.control.calls)).toHaveLength(1);
      expect(yield* listed(attachId)).toMatchObject({ state: "paused" });
    }),
  ),
);

it.effect("a machine removed from Pen while its route is read is not moved on afterwards", () =>
  world((pen, home, _grant, host) =>
    Effect.gen(function* () {
      withIdentity(home);
      const { attachId } = yield* joined(pen, host, 1);
      const hold = yield* makeHold();
      host.control.holdRoute = hold;
      const pass = yield* Effect.forkChild(enroll);
      yield* Deferred.await(hold.arrived);
      pen.members.delete(key(1));
      expect(yield* listed(attachId)).toMatchObject({ state: "failed", penMember: false });
      yield* Deferred.succeed(hold.release, undefined);
      yield* Fiber.join(pass);
      host.control.holdRoute = undefined;
      yield* enroll;
      yield* enroll;
      expect(yield* listed(attachId)).toMatchObject({ state: "failed", penMember: false });
      expect(linkAdds(host.control.calls)).toEqual([]);
    }),
  ),
);

it.effect("two machines whose routes complete together cannot both take one SSH host key", () =>
  world((pen, home, _grant, host) =>
    Effect.gen(function* () {
      withIdentity(home);
      const first = yield* joined(pen, host, 1);
      const second = yield* joined(pen, host, 2);
      host.control.routes.set(
        second.nodeId,
        penRouteOf({ nodeId: second.nodeId, noisePub: key(102) }, "ssh-ed25519 " + "1".repeat(68)),
      );
      // Both have checked for a shared pin when they write their known_hosts.
      const hold = yield* makeHold(2);
      host.control.holdKnownHosts = hold;
      const pass = yield* Effect.forkChild(enroll);
      yield* Deferred.await(hold.arrived);
      yield* Deferred.succeed(hold.release, undefined);
      yield* Fiber.join(pass);
      const pinned = (yield* rows).filter((row) => row.sshd_pin !== null);
      expect(pinned).toHaveLength(1);
      const states = [yield* listed(first.attachId), yield* listed(second.attachId)].map(
        (machine) => machine?.class,
      );
      expect(states.toSorted()).toEqual(["conflict", "disposable"]);
    }),
  ),
);

it.effect(
  "a link OpenCodex never journals is sent at most three times, then stops for a person",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        withIdentity(home);
        const { attachId } = yield* joined(pen, host, 1);
        for (let n = 0; n < 300; n += 1) host.control.adds.push("not_journalled");
        yield* enroll;
        yield* enroll;
        // Passes 30 s apart for three hours, as the reconcile loop runs them.
        for (let pass = 0; pass < 360; pass += 1) {
          yield* enroll;
          yield* TestClock.adjust(30_000);
        }
        expect(linkAdds(host.control.calls)).toHaveLength(3);
        expect(yield* listed(attachId)).toMatchObject({
          state: "paused",
          message: expect.stringContaining("before recording it"),
        });
      }),
    ),
);

it.effect(
  "an operation a Home restart left open is repeated under its id once it outlives ocx, and settles",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        withIdentity(home);
        const { attachId } = yield* joined(pen, host, 1);
        host.control.adds.push("open");
        yield* enroll;
        yield* enroll;
        yield* enroll; // the add left its entry open
        yield* enroll;
        expect(linkAdds(host.control.calls)).toHaveLength(1);
        expect(yield* listed(attachId)).toMatchObject({ state: "attaching" });
        // Past ocx's own deadline and the alias-lock wait, nothing can still be running it.
        yield* TestClock.adjust(10 * 60 * 1000);
        yield* enroll; // first sight of the stale entry after the wait
        yield* enroll;
        expect(linkAdds(host.control.calls).map((args) => args[8])).toEqual([
          attachId + ".link.1",
          attachId + ".link.1",
        ]);
        expect(yield* listed(attachId)).toMatchObject({ state: "unknown" });
      }),
    ),
);

it.effect(
  "a linked machine removed from Pen keeps its link named, with the step that removes it",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        withIdentity(home);
        const { attachId } = yield* joined(pen, host, 1);
        for (let pass = 0; pass < 4; pass += 1) yield* enroll;
        expect(yield* listed(attachId)).toMatchObject({ state: "linked" });
        pen.members.delete(key(1));
        yield* listed(attachId);
        yield* enroll;
        expect(yield* listed(attachId)).toMatchObject({
          state: "failed",
          penMember: false,
          message: expect.stringContaining("ocx link revoke --link-id lnk_0000000000000001"),
        });
      }),
    ),
);

it.effect(
  "a link that commits while its machine is removed from Pen is still recorded and named",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        withIdentity(home);
        const { attachId } = yield* joined(pen, host, 1);
        yield* enroll;
        yield* enroll;
        const hold = yield* makeHold();
        host.control.holdOperations = hold;
        const pass = yield* Effect.forkChild(enroll); // the add commits; its read back is held
        yield* Deferred.await(hold.arrived);
        pen.members.delete(key(1));
        yield* listed(attachId);
        yield* Deferred.succeed(hold.release, undefined);
        yield* Fiber.join(pass);
        host.control.holdOperations = undefined;
        yield* enroll;
        expect(yield* listed(attachId)).toMatchObject({
          state: "failed",
          message: expect.stringContaining("ocx link revoke --link-id lnk_0000000000000001"),
        });
      }),
    ),
);

it.effect("a known_hosts GOAT cannot write waits; it is not read as a changed host key", () =>
  world((pen, home, _grant, host) =>
    Effect.gen(function* () {
      withIdentity(home);
      const { attachId } = yield* joined(pen, host, 1);
      host.control.knownHostsUnwritable = true;
      yield* enroll;
      expect(yield* listed(attachId)).toMatchObject({
        state: "admitted",
        class: "disposable",
        message: expect.stringContaining("could not write"),
      });
      host.control.knownHostsUnwritable = false;
      yield* enroll;
      expect(yield* listed(attachId)).toMatchObject({ state: "attaching", step: "reach" });
    }),
  ),
);

it.effect("reach tells a refused key, a changed host key and an unusable key apart", () =>
  world((pen, home, _grant, host) =>
    Effect.gen(function* () {
      withIdentity(home);
      const first = yield* joined(pen, host, 1);
      yield* enroll; // route
      host.control.reachAnswers.set(first.nodeId, "key_refused");
      yield* enroll;
      // People see the message on web and mobile: it says what to do and where the key is.
      expect(yield* listed(first.attachId)).toMatchObject({
        state: "attaching",
        message: expect.stringMatching(
          /refused this hub's machine key.*authorized_keys.*Settings → Hub/su,
        ),
      });
      host.control.reachAnswers.set(first.nodeId, "unreachable");
      yield* enroll;
      expect(yield* listed(first.attachId)).toMatchObject({
        message: expect.stringContaining("through Pen"),
      });
      host.control.reachAnswers.set(first.nodeId, "host_key_changed");
      yield* enroll;
      expect(yield* listed(first.attachId)).toMatchObject({ class: "conflict", state: "paused" });
      // A key Pen changed before the reach is a conflict too, before any ssh.
      const second = yield* joined(pen, host, 2);
      yield* enroll; // route
      host.control.routes.set(
        second.nodeId,
        penRouteOf({ nodeId: second.nodeId, noisePub: key(102) }, "ssh-ed25519 " + "Y".repeat(68)),
      );
      const reachesBefore = host.control.reached.length;
      yield* enroll;
      expect(host.control.reached).toHaveLength(reachesBefore);
      expect(yield* listed(second.attachId)).toMatchObject({ class: "conflict" });
    }),
  ),
);

it.effect("a stop that lost its record to another step writes no audit row", () =>
  world((pen, home, _grant, host) =>
    Effect.gen(function* () {
      withIdentity(home);
      const { attachId, nodeId } = yield* joined(pen, host, 1);
      host.control.routes.set(nodeId, { kind: "refused", reason: "other_pen" });
      const hold = yield* makeHold();
      host.control.holdRoute = hold;
      const pass = yield* Effect.forkChild(enroll);
      yield* Deferred.await(hold.arrived);
      pen.members.delete(key(1));
      yield* listed(attachId);
      yield* Deferred.succeed(hold.release, undefined);
      yield* Fiber.join(pass);
      const sql = yield* SqlClient.SqlClient;
      const stops = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM audit_events
        WHERE target = ${attachId} AND outcome LIKE 'stopped:%'`;
      expect(stops[0]?.n).toBe(0);
    }),
  ),
);

it.effect("a 404 from a Home that does not serve the journal is not read as never journalled", () =>
  world((pen, home, _grant, host) =>
    Effect.gen(function* () {
      withIdentity(home);
      const { attachId } = yield* joined(pen, host, 1);
      host.control.adds.push("not_journalled");
      yield* enroll;
      yield* enroll;
      yield* enroll; // sent once
      host.control.journalRouteMissing = true;
      yield* enroll;
      yield* enroll;
      expect(linkAdds(host.control.calls)).toHaveLength(1);
      expect(yield* listed(attachId)).toMatchObject({
        state: "attaching",
        message: expect.stringContaining("could not be read"),
      });
    }),
  ),
);

it.effect(
  "one enrollment pass asks OpenCodex for its contracts once, however many machines wait",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        yield* joined(pen, host, 1);
        yield* joined(pen, host, 2);
        yield* enroll;
        yield* enroll; // both at the link step now
        const before = home.contractsAsked;
        yield* enroll;
        expect(home.contractsAsked - before).toBe(1);
      }),
    ),
);

it.effect("an attach that loses its authority after the machine joined says so in that order", () =>
  world((pen, home, _grant, host) =>
    Effect.gen(function* () {
      withIdentity(home);
      const { attachId } = yield* joined(pen, host, 1);
      yield* TestClock.adjust(60_000);
      yield* switchTo({ enabled: false });
      yield* enroll;
      const machine = yield* listed(attachId);
      expect(machine).toMatchObject({ state: "paused" });
      expect(machine?.message).toContain("then lost its authority");
      expect(machine?.message).not.toContain("joined Pen after");
    }),
  ),
);

it.effect("a list of records never makes the machine key; only attach does", () =>
  world((_pen, _home, _grant, host) =>
    Effect.gen(function* () {
      yield* Effect.flatMap(Attach.DisposableAttach, (service) => service.list({}));
      expect(host.control.keysMade).toBe(0);
      yield* attach(1);
      expect(host.control.keysMade).toBe(1);
      yield* Effect.flatMap(Attach.DisposableAttach, (service) => service.list({}));
      expect(host.control.keysMade).toBe(1);
    }),
  ),
);

it.effect("a journal that stays unreadable for 2 hours after the send stops for a person", () =>
  world((pen, home, _grant, host) =>
    Effect.gen(function* () {
      withIdentity(home);
      const { attachId } = yield* joined(pen, host, 1);
      host.control.journalUnreadable = true;
      yield* enroll;
      yield* enroll;
      yield* enroll; // sent; the read back fails
      yield* enroll;
      expect(yield* listed(attachId)).toMatchObject({ state: "attaching" });
      yield* TestClock.adjust(2 * HOUR);
      yield* enroll;
      expect(linkAdds(host.control.calls)).toHaveLength(1);
      expect(yield* listed(attachId)).toMatchObject({
        state: "unknown",
        message: expect.stringContaining("for two hours"),
      });
    }),
  ),
);

it.effect(
  "a missing known_hosts at reach is a wait that rewrites the pinned line, never a conflict",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        withIdentity(home);
        const { attachId, nodeId } = yield* joined(pen, host, 1);
        yield* enroll; // route
        const pinned = host.control.knownHosts.get(attachId);
        host.control.knownHosts.delete(attachId);
        host.control.reachAnswers.set(nodeId, "host_key_unknown");
        yield* enroll;
        expect(host.control.knownHosts.get(attachId)).toBe(pinned);
        expect(yield* listed(attachId)).toMatchObject({
          state: "attaching",
          class: "disposable",
          message: expect.stringContaining("no host key"),
        });
      }),
    ),
);

it.effect("a pass that finds a contract missing does not reset the sends of the stored id", () =>
  world((pen, home, _grant, host) =>
    Effect.gen(function* () {
      withIdentity(home);
      const { attachId } = yield* joined(pen, host, 1);
      for (let n = 0; n < 20; n += 1) host.control.adds.push("not_journalled");
      yield* enroll;
      yield* enroll;
      yield* enroll; // first send
      yield* enroll; // second send
      const full = home.contracts;
      home.contracts = new Set(["link.route/1", "link.operation/1", "link.recover/1"]);
      yield* enroll;
      home.contracts = full;
      for (let pass = 0; pass < 6; pass += 1) yield* enroll;
      expect(linkAdds(host.control.calls)).toHaveLength(3);
      expect(yield* listed(attachId)).toMatchObject({ state: "paused" });
    }),
  ),
);

it.effect(
  "a machine removed from Pen after a link attempt that left nothing is not said to hold an operation",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        withIdentity(home);
        const { attachId } = yield* joined(pen, host, 1);
        host.control.adds.push({ failedClean: "full_install_present" });
        for (let pass = 0; pass < 3; pass += 1) yield* enroll;
        expect(yield* listed(attachId)).toMatchObject({ state: "paused" });
        pen.members.delete(key(1));
        yield* listed(attachId);
        yield* enroll;
        const machine = yield* listed(attachId);
        expect(machine).toMatchObject({ state: "failed", penMember: false });
        expect(machine?.message).not.toContain("link operation");
        expect(machine?.message).toContain("removed from Pen");
      }),
    ),
);

it.effect("a machine key path OpenCodex would refuse stops the link before any ocx", () =>
  world((pen, home, _grant, host) =>
    Effect.gen(function* () {
      withIdentity(home);
      const { attachId } = yield* joined(pen, host, 1);
      // OpenCodex takes an identity file of letters, digits and ._+/- only.
      host.control.keyFile = "/Users/a person/.goat/userdata/disposable/machine_ed25519";
      yield* enroll;
      host.control.keyFile = MACHINE_KEY_FILE;
      yield* enroll;
      host.control.keyFile = "/srv/goat~x/disposable/machine_ed25519";
      yield* enroll;
      expect(linkAdds(host.control.calls)).toEqual([]);
      expect(yield* listed(attachId)).toMatchObject({
        state: "paused",
        message: expect.stringContaining("state folder"),
      });
    }),
  ),
);

it.effect("an entry that stays open through three sends of its id stops for a person", () =>
  world((pen, home, _grant, host) =>
    Effect.gen(function* () {
      withIdentity(home);
      const { attachId } = yield* joined(pen, host, 1);
      host.control.adds.push("open");
      host.control.openStaysOpen = true;
      for (let pass = 0; pass < 4; pass += 1) yield* enroll;
      for (let round = 0; round < 4; round += 1) {
        yield* TestClock.adjust(11 * 60 * 1000);
        yield* enroll;
        yield* enroll;
      }
      expect(linkAdds(host.control.calls)).toHaveLength(3);
      expect(yield* listed(attachId)).toMatchObject({
        state: "unknown",
        message: expect.stringContaining("left the link operation open"),
      });
    }),
  ),
);
