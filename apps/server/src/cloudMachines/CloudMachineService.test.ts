import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  CloudMachineError,
  type BoatSandboxId,
  type CloudMachineAlias,
  type CloudMachineErrorReason,
  type CloudMachineState,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { BoatClient, type BoatSshEndpoint } from "./BoatClient.ts";
import * as CloudMachineService from "./CloudMachineService.ts";
import { CloudMachineSsh } from "./sshConfig.ts";

const ID = "bx_23456789" as BoatSandboxId;
const SECOND_ID = "bx_3456789a" as BoatSandboxId;
const ALIAS = "boat-bx_23456789" as CloudMachineAlias;
const HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOv8eZbJtFiAHk3Fp2Kq";

/** A scripted Boat and SSH writer that record every call. */
const makeWorld = () => {
  const states = new Map<string, CloudMachineState>();
  const calls: Array<string> = [];
  const createKeys: Array<string> = [];
  const failures = new Map<string, CloudMachineErrorReason>();
  const missing = new Set<string>();
  const ids: Array<BoatSandboxId> = [ID, SECOND_ID];
  let endpoint: BoatSshEndpoint = {
    host: "203.0.113.10",
    port: 22,
    user: "user",
    hostKey: HOST_KEY,
  };
  let written: BoatSshEndpoint | null = null;
  const removedHosts: Array<string> = [];
  const invalidated: Array<string> = [];
  const secrets = new Map<string, Uint8Array>();
  const createdFor = new Map<string, BoatSandboxId>();
  const holds = new Map<string, Deferred.Deferred<void>>();
  const hold = (name: string) =>
    Effect.suspend(() => {
      const gate = holds.get(name);
      return gate === undefined ? Effect.void : Deferred.await(gate);
    });

  const call = (name: string) =>
    Effect.suspend(() => {
      calls.push(name);
      const reason = failures.get(name);
      if (reason === undefined) return Effect.void;
      failures.delete(name);
      return Effect.fail(new CloudMachineError({ reason }));
    });
  const sandbox = (id: BoatSandboxId) => ({ id, name: null, state: states.get(id)! });

  const boat = BoatClient.of({
    checkKey: () => call("checkKey"),
    get: (_key, id) =>
      call("get").pipe(
        Effect.flatMap(() => hold("get")),
        Effect.flatMap(() =>
          missing.has(id)
            ? Effect.fail(new CloudMachineError({ reason: "not_found" }))
            : Effect.succeed(sandbox(id)),
        ),
      ),
    // Like Boat, a repeated Idempotency-Key returns the machine the first request made.
    create: (_key, _input, idempotencyKey) =>
      Effect.sync(() => {
        createKeys.push(idempotencyKey);
        let id = createdFor.get(idempotencyKey);
        if (id === undefined) {
          id = ids.shift()!;
          createdFor.set(idempotencyKey, id);
          states.set(id, "provisioning");
        }
        return id;
      }).pipe(Effect.flatMap((id) => call("create").pipe(Effect.as(sandbox(id))))),
    update: (_key, _id, patch) => call(`update:${JSON.stringify(patch)}`),
    stop: (_key, id) =>
      call("stop").pipe(Effect.tap(() => Effect.sync(() => states.set(id, "archiving")))),
    resume: (_key, id) =>
      call("resume").pipe(Effect.tap(() => Effect.sync(() => states.set(id, "ready")))),
    remove: () => call("remove"),
    authorizeSshKey: () => call("sshkey").pipe(Effect.map(() => endpoint)),
  });

  const ssh = CloudMachineSsh.of({
    installInclude: call("installInclude"),
    ensureKey: Effect.succeed({
      identityFile: "/home/.ssh/goat-cloud/id_ed25519",
      publicKey: "ssh-ed25519 AAAA",
    }),
    writeHost: (_alias, next) =>
      Effect.sync(() => {
        const changed = written === null || JSON.stringify(written) !== JSON.stringify(next);
        written = next;
        return { changed };
      }),
    removeHost: (alias) => Effect.sync(() => void removedHosts.push(alias)),
  });

  const secretStore = {
    get: (name: string) => Effect.sync(() => Option.fromNullishOr(secrets.get(name))),
    set: (name: string, value: Uint8Array) => Effect.sync(() => void secrets.set(name, value)),
    getOrCreateRandom: () => Effect.die("unused"),
    remove: (name: string) => Effect.sync(() => void secrets.delete(name)),
  } as unknown as ServerSecretStore.ServerSecretStore["Service"];

  return {
    states,
    calls,
    createKeys,
    failures,
    missing,
    removedHosts,
    invalidated,
    secrets,
    holds,
    moveEndpoint: () => {
      endpoint = { ...endpoint, host: "198.51.100.7" };
    },
    layer: CloudMachineService.layerWithoutDependencies.pipe(
      Layer.provide(Layer.succeed(BoatClient, boat)),
      Layer.provide(Layer.succeed(CloudMachineSsh, ssh)),
      Layer.provide(Layer.succeed(ServerSecretStore.ServerSecretStore, secretStore)),
      Layer.provide(ServerConfig.layerTest("/fixture", { prefix: "goat-cloud-machines-test-" })),
      Layer.provide(NodeCrypto.layer),
      Layer.provide(NodeServices.layer),
    ),
  };
};

type World = ReturnType<typeof makeWorld>;
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
          const gate = yield* Deferred.make<void>();
          world.holds.set("get", gate);
          const getsBefore = world.calls.filter((name) => name === "get").length;
          const waiting = yield* service
            .ensureReady(ALIAS, { wake: true })
            .pipe(Effect.flip, Effect.forkChild);
          // Deadline is captured before boat.get. Hold that call, advance the clock, then release.
          let spins = 0;
          while (world.calls.filter((name) => name === "get").length === getsBefore) {
            if (++spins > 10_000) return yield* Effect.die("ensureReady never reached Boat");
            yield* Effect.yieldNow;
          }
          yield* Effect.yieldNow;
          yield* TestClock.adjust(Duration.millis(CloudMachineService.READY_DEADLINE_MS));
          yield* Deferred.succeed(gate, undefined);
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
});
