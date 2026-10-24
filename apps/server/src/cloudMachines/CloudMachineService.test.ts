import { describe, expect, it } from "@effect/vitest";
import { CloudMachineError, type CloudMachineState } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as CloudMachineService from "./CloudMachineService.ts";
import { ALIAS, ID, SECOND_ID, makeWorld, type World } from "./CloudMachineService.testkit.ts";

type Service = CloudMachineService.CloudMachineService["Service"];

/** Runs against a fresh service with a stored key and, when given, one owned machine in that state. */
const withService = <A, E>(
  world: World,
  options: { readonly ownedState?: CloudMachineState },
  use: (service: Service) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const service = yield* CloudMachineService.CloudMachineService;
    yield* service.onAliasInvalidated((alias) =>
      Effect.sync(() => void world.invalidated.push(alias)),
    );
    yield* service.configure({ apiKey: "boat_test_key", consentToSshInclude: true });
    if (options.ownedState !== undefined) {
      yield* service.create({ label: "Build box", type: "small", ttlSeconds: 3600 });
      world.states.set(ID, options.ownedState);
    }
    world.calls.length = 0;
    world.invalidated.length = 0;
    return yield* use(service);
  }).pipe(Effect.provide(world.layer));

describe("CloudMachineService.ensureReady", () => {
  it.effect("wakes a stopped machine once for concurrent explicit callers", () =>
    Effect.gen(function* () {
      const world = makeWorld();
      yield* withService(world, { ownedState: "archived" }, (service) =>
        Effect.gen(function* () {
          const results = yield* Effect.all(
            [
              service.ensureReady(ALIAS, { wake: true }),
              service.ensureReady(ALIAS, { wake: true }),
            ],
            { concurrency: "unbounded" },
          );
          expect(results.map((result) => result.alias)).toEqual([ALIAS, ALIAS]);
          expect(world.calls.filter((name) => name === "resume")).toHaveLength(1);
          expect(world.calls.filter((name) => name === "sshkey")).toHaveLength(1);
          expect(world.calls).toContain('update:{"ttlSeconds":3600}');

          // A later explicit Resume asks Boat again rather than trusting the earlier result.
          world.states.set(ID, "archived");
          yield* service.ensureReady(ALIAS, { wake: true });
          expect(world.calls.filter((name) => name === "resume")).toHaveLength(2);
        }),
      );
    }),
  );

  it.effect("never wakes or extends a machine for a non-waking check", () =>
    Effect.gen(function* () {
      const world = makeWorld();
      yield* withService(world, { ownedState: "archived" }, (service) =>
        Effect.gen(function* () {
          const error = yield* service.ensureReady(ALIAS, { wake: false }).pipe(Effect.flip);
          expect(error.reason).toBe("stopped");
          expect(world.calls).toEqual(["get"]);

          world.states.set(ID, "running");
          world.calls.length = 0;
          yield* service.ensureReady(ALIAS, { wake: false });
          expect(world.calls).toEqual(["get", "sshkey"]);

          // Reused for a minute without asking Boat again.
          world.calls.length = 0;
          yield* service.ensureReady(ALIAS, { wake: false });
          expect(world.calls).toEqual([]);
          yield* TestClock.adjust("61 seconds");
          yield* service.ensureReady(ALIAS, { wake: false });
          expect(world.calls).toEqual(["get", "sshkey"]);

          // Listing never resumes either.
          world.states.set(ID, "archived");
          world.calls.length = 0;
          yield* service.list();
          expect(world.calls).toEqual(["get"]);
        }),
      );
    }),
  );

  it.effect("drops SSH caches only when the address or host key changed", () =>
    Effect.gen(function* () {
      const world = makeWorld();
      yield* withService(world, { ownedState: "running" }, (service) =>
        Effect.gen(function* () {
          expect((yield* service.ensureReady(ALIAS, { wake: true })).endpointChanged).toBe(true);
          expect(world.invalidated).toEqual([ALIAS]);
          yield* TestClock.adjust("61 seconds");
          expect((yield* service.ensureReady(ALIAS, { wake: true })).endpointChanged).toBe(false);
          expect(world.invalidated).toEqual([ALIAS]);
          world.moveEndpoint();
          yield* TestClock.adjust("61 seconds");
          expect((yield* service.ensureReady(ALIAS, { wake: true })).endpointChanged).toBe(true);
          expect(world.invalidated).toEqual([ALIAS, ALIAS]);
        }),
      );
    }),
  );

  it.effect("reports an expired snapshot and a readiness timeout as distinct failures", () =>
    Effect.gen(function* () {
      const world = makeWorld();
      yield* withService(world, { ownedState: "archived" }, (service) =>
        Effect.gen(function* () {
          world.failures.set("resume", "snapshot_expired");
          const expired = yield* service.ensureReady(ALIAS, { wake: true }).pipe(Effect.flip);
          expect(expired.reason).toBe("snapshot_expired");
          expect((yield* service.list()).machines[0]?.lastError).toBe(expired.message);

          world.states.set(ID, "provisioning");
          const reading = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          // The deadline is captured before boat.get: hold that call while the clock passes it.
          world.milestones.onGet = Deferred.succeed(reading, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
          );
          const waiting = yield* service
            .ensureReady(ALIAS, { wake: true })
            .pipe(Effect.flip, Effect.forkChild);
          yield* Deferred.await(reading);
          yield* TestClock.adjust(Duration.millis(CloudMachineService.READY_DEADLINE_MS));
          yield* Deferred.succeed(release, undefined);
          expect((yield* Fiber.join(waiting)).reason).toBe("readiness_timeout");
        }),
      );
    }),
  );

  it.effect("refuses an alias this server does not manage without calling Boat", () =>
    Effect.gen(function* () {
      const world = makeWorld();
      yield* withService(world, {}, (service) =>
        Effect.gen(function* () {
          const error = yield* service.ensureReady(ALIAS, { wake: true }).pipe(Effect.flip);
          expect(error.reason).toBe("not_found");
          expect(world.calls).toEqual([]);
          expect(yield* service.owns(ALIAS)).toBe(false);
        }),
      );
    }),
  );
});

describe("CloudMachineService lifecycle", () => {
  it.effect("keeps a created machine when naming it fails", () =>
    Effect.gen(function* () {
      const world = makeWorld();
      yield* withService(world, {}, (service) =>
        Effect.gen(function* () {
          world.failures.set('update:{"name":"Build box"}', "conflict");
          const created = yield* service.create({
            label: "Build box",
            type: "small",
            ttlSeconds: 3600,
          });
          expect(created).toMatchObject({
            alias: ALIAS,
            state: "provisioning",
            label: "Build box",
          });
          const listed = yield* service.list();
          expect(listed.machines.map((machine) => machine.alias)).toEqual([ALIAS]);
          expect(listed.machines[0]?.lastError).not.toBeNull();
        }),
      );
    }),
  );

  it.effect("replays a create whose response was lost only on the next create", () =>
    Effect.gen(function* () {
      const world = makeWorld();
      yield* withService(world, {}, (service) =>
        Effect.gen(function* () {
          world.failures.set("create", "transport_error");
          const lost = yield* service
            .create({ label: "Build box", type: "small", ttlSeconds: 3600 })
            .pipe(Effect.flip);
          expect(lost.reason).toBe("transport_error");
          // Reading the list never sends a create.
          const listed = yield* service.list();
          expect(listed).toMatchObject({ unconfirmedCreates: 1, machines: [] });
          expect(world.createKeys).toHaveLength(1);
          yield* service.create({ label: "Second", type: "large", ttlSeconds: 600 });
          const [first, replay, second] = world.createKeys;
          expect(replay).toBe(first);
          expect(second).not.toBe(first);
          expect(world.createKeys).toHaveLength(3);
          const after = yield* service.list();
          expect(after.unconfirmedCreates).toBe(0);
          expect(after.machines.map((machine) => machine.sandboxId)).toEqual([ID, SECOND_ID]);
        }),
      );
    }),
  );

  it.effect("never replays a create Boat has forgotten, and counts it until dismissed", () =>
    Effect.gen(function* () {
      const world = makeWorld();
      yield* withService(world, {}, (service) =>
        Effect.gen(function* () {
          world.failures.set("create", "transport_error");
          yield* service
            .create({ label: "Build box", type: "small", ttlSeconds: 3600 })
            .pipe(Effect.flip);
          // A recent unconfirmed request is never dismissed; it may still be in flight.
          expect(yield* service.dismissUnconfirmedCreates()).toEqual({ dismissed: 0 });
          yield* TestClock.adjust("24 hours");
          yield* service.create({ label: "Second", type: "large", ttlSeconds: 600 });
          // Only the new request was sent; the stale one would have made a second machine.
          expect(world.createKeys).toHaveLength(2);
          expect((yield* service.list()).unconfirmedCreates).toBe(1);
          expect(yield* service.dismissUnconfirmedCreates()).toEqual({ dismissed: 1 });
          expect((yield* service.list()).unconfirmedCreates).toBe(0);
        }),
      );
    }),
  );
  it.effect("drops a create Boat refused instead of replaying it", () =>
    Effect.gen(function* () {
      const world = makeWorld();
      yield* withService(world, {}, (service) =>
        Effect.gen(function* () {
          world.failures.set("create", "billing_required");
          const refused = yield* service
            .create({ label: "Build box", type: "small", ttlSeconds: 3600 })
            .pipe(Effect.flip);
          expect(refused.reason).toBe("billing_required");
          yield* service.list();
          expect(world.createKeys).toHaveLength(1);
        }),
      );
    }),
  );

  it.effect("keeps a deleted machine until Boat no longer shows it", () =>
    Effect.gen(function* () {
      const world = makeWorld();
      yield* withService(world, { ownedState: "running" }, (service) =>
        Effect.gen(function* () {
          const deleting = yield* service.delete(ALIAS);
          expect(deleting.deletePending).toBe(true);
          expect(world.removedHosts).toEqual([ALIAS]);
          expect(world.invalidated).toEqual([ALIAS]);
          expect((yield* service.list()).machines.map((machine) => machine.deletePending)).toEqual([
            true,
          ]);
          // A key that cannot see the machine does not prove it is gone.
          world.failures.set("get", "scope_denied");
          expect((yield* service.list()).machines.map((machine) => machine.presence)).toEqual([
            "unknown",
          ]);
          world.missing.add(ID);
          expect((yield* service.list()).machines).toEqual([]);
        }),
      );
    }),
  );

  it.effect("keeps the catalog when Boat refuses a delete", () =>
    Effect.gen(function* () {
      const world = makeWorld();
      yield* withService(world, { ownedState: "running" }, (service) =>
        Effect.gen(function* () {
          world.failures.set("remove", "conflict");
          expect((yield* service.delete(ALIAS).pipe(Effect.flip)).reason).toBe("conflict");
          expect(world.removedHosts).toEqual([]);
          expect((yield* service.list()).machines[0]?.deletePending).toBe(false);
        }),
      );
    }),
  );

  it.effect("forgets only a stopped machine or one Boat no longer shows", () =>
    Effect.gen(function* () {
      const world = makeWorld();
      yield* withService(world, { ownedState: "running" }, (service) =>
        Effect.gen(function* () {
          expect((yield* service.forget(ALIAS).pipe(Effect.flip)).reason).toBe("forget_refused");
          world.states.set(ID, "archived");
          yield* service.forget(ALIAS);
          expect((yield* service.list()).machines).toEqual([]);
          expect(world.removedHosts).toEqual([ALIAS]);
        }),
      );
    }),
  );

  it.effect("disconnecting removes the key and SSH files but keeps the machines listed", () =>
    Effect.gen(function* () {
      const world = makeWorld();
      yield* withService(world, { ownedState: "running" }, (service) =>
        Effect.gen(function* () {
          yield* service.disconnect();
          expect(world.secrets.size).toBe(0);
          expect(world.removedHosts).toEqual([ALIAS]);
          const listed = yield* service.list();
          expect(listed.configured).toBe(false);
          expect(listed.machines).toMatchObject([{ alias: ALIAS, presence: "unknown" }]);
          expect((yield* service.stop(ALIAS).pipe(Effect.flip)).reason).toBe("not_configured");
        }),
      );
    }),
  );

  it.effect(
    "only delete and forget signal that the machine is gone, after their removal hook ran",
    () =>
      Effect.gen(function* () {
        const world = makeWorld();
        yield* withService(world, { ownedState: "running" }, (service) =>
          Effect.gen(function* () {
            const signals: Array<string> = [];
            yield* service.onRemoving((alias) =>
              Effect.sync(() => void signals.push(`removing ${alias} after ${world.calls.at(-1)}`)),
            );
            yield* service.onAliasInvalidated((alias, cause) =>
              Effect.sync(() => void signals.push(`${cause} ${alias}`)),
            );
            yield* service.stop(ALIAS);
            yield* service.disconnect();
            yield* service.configure({ apiKey: "boat_test_key", consentToSshInclude: true });
            expect(signals).toEqual([`lifecycle ${ALIAS}`, `lifecycle ${ALIAS}`]);
            expect(yield* service.isRemoved(ALIAS)).toBe(false);

            world.states.set(ID, "archived");
            signals.length = 0;
            yield* service.forget(ALIAS);
            // Recorded while the catalog still names the machine, after Boat confirmed it stopped.
            expect(signals).toEqual([`removing ${ALIAS} after get`, `removed ${ALIAS}`]);
            expect(yield* service.isRemoved(ALIAS)).toBe(true);
          }),
        );
        const deleting = makeWorld();
        yield* withService(deleting, { ownedState: "running" }, (service) =>
          Effect.gen(function* () {
            const signals: Array<string> = [];
            yield* service.onRemoving((alias) =>
              Effect.sync(
                () => void signals.push(`removing ${alias} after ${deleting.calls.at(-1)}`),
              ),
            );
            yield* service.onAliasInvalidated((alias, cause) =>
              Effect.sync(() => void signals.push(`${cause} ${alias}`)),
            );
            yield* service.delete(ALIAS);
            // Only after Boat accepted the delete, so a refused one leaves nothing to undo.
            expect(signals).toEqual([`removing ${ALIAS} after remove`, `removed ${ALIAS}`]);
            // A delete Boat accepted ends ownership even while the catalog still lists it.
            expect(yield* service.isRemoved(ALIAS)).toBe(true);
            deleting.failures.set("remove", "conflict");
            signals.length = 0;
            expect((yield* service.delete(ALIAS).pipe(Effect.flip)).reason).toBe("conflict");
            expect(signals).toEqual([]);
          }),
        );
      }),
  );

  it.effect("a removal hook that fails keeps the machine in the catalog", () =>
    Effect.gen(function* () {
      const world = makeWorld();
      yield* withService(world, { ownedState: "archived" }, (service) =>
        Effect.gen(function* () {
          yield* service.onRemoving(() =>
            Effect.fail(new CloudMachineError({ reason: "storage_failed" })),
          );
          expect((yield* service.forget(ALIAS).pipe(Effect.flip)).reason).toBe("storage_failed");
          expect((yield* service.delete(ALIAS).pipe(Effect.flip)).reason).toBe("storage_failed");
          expect(world.removedHosts).toEqual([]);
          expect(world.invalidated).toEqual([]);
          expect(yield* service.isRemoved(ALIAS)).toBe(false);
          expect((yield* service.list()).machines).toMatchObject([
            { alias: ALIAS, deletePending: false },
          ]);
        }),
      );
    }),
  );
});

it.effect("reads a local catalog without Boat and signals catalog writes", () =>
  Effect.gen(function* () {
    const world = makeWorld();
    yield* withService(world, {}, (service) =>
      Effect.scoped(
        Effect.gen(function* () {
          const changed = yield* service.changes.pipe(
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped({ startImmediately: true }),
          );
          yield* service.create({ label: "Build box", type: "small", ttlSeconds: 3600 });
          yield* Fiber.join(changed);
          world.calls.length = 0;
          expect(yield* service.catalog).toEqual([{ alias: ALIAS, label: "Build box" }]);
          expect(world.calls).toEqual([]);
        }),
      ),
    );
  }),
);
