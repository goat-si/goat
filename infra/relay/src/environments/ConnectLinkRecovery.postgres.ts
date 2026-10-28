import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { RELAY_LINK_PROOF_TYP } from "@goat/shared/relayJwt";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Statement from "effect/sql/Statement";
import * as RelayDb from "../db.ts";
import * as Configuration from "../Config.ts";
import * as Dpop from "../auth/DpopProofs.ts";
import * as Tokens from "../auth/RelayTokens.ts";
import { unlinkEnvironmentRecord } from "../http/Api.ts";
import * as HookInbox from "../hooks/HookInbox.ts";
import {
  awaitPostgresMilestone,
  postgresFixture,
  postgresPolicyFixture,
} from "../auth/connectPostgres.testkit.ts";
import * as Intents from "./ManagedProvisioningIntents.ts";
import * as Allocations from "./ManagedEndpointAllocations.ts";
import * as Provider from "./ManagedEndpointProvider.ts";
import * as Reservations from "./ConnectLinkReservations.ts";
import * as Linker from "./EnvironmentLinker.ts";
import * as Links from "./EnvironmentLinks.ts";
import * as Credentials from "./EnvironmentCredentials.ts";
import { setup } from "./EnvironmentLinker.postgres.testkit.ts";
import {
  config,
  environmentKeyPair,
  makeAssurance,
  intent,
  signTestJwt,
} from "./EnvironmentLinker.testkit.ts";

function fixture(gate?: {
  readonly at: "create" | "token";
  readonly wait: Effect.Effect<void>;
  readonly replacementWait?: Effect.Effect<void>;
}) {
  let heldToken = false;
  const tunnels = new Map<string, string>();
  const dns = new Map<string, string>();
  let sequence = 0;
  let failDelete = false;
  const tunnelClient = Provider.layerTunnelClient({
    get: (id) =>
      Effect.suspend(() =>
        tunnels.has(id)
          ? Effect.succeed({ id, name: tunnels.get(id) })
          : Effect.fail(
              new Provider.ManagedEndpointTunnelClientError({
                operation: "get",
                tunnelId: id,
                cause: { _tag: "NotFound" },
              }),
            ),
      ),
    list: () => Effect.sync(() => ({ result: [...tunnels].map(([id, name]) => ({ id, name })) })),
    create: Effect.fn("ConnectLinkRecovery.tunnels.create")(function* ({ name }) {
      const id = `tunnel-${++sequence}`;
      tunnels.set(id, name);
      if (gate?.at === "create" && !heldToken) {
        heldToken = true;
        yield* gate.wait;
      } else if (gate?.at === "create" && gate.replacementWait) {
        yield* gate.replacementWait;
      }
      return { id, name };
    }),
    putConfiguration: () => Effect.void,
    getToken: Effect.fn("ConnectLinkRecovery.tunnels.getToken")(function* (id) {
      if (gate?.at === "token" && !heldToken) {
        heldToken = true;
        yield* gate.wait;
      }
      return `connector:${id}`;
    }),
    delete: (id) =>
      Effect.suspend(() =>
        failDelete
          ? Effect.fail(
              new Provider.ManagedEndpointTunnelClientError({
                operation: "delete",
                tunnelId: id,
                cause: "unavailable",
              }),
            )
          : Effect.sync(() => {
              tunnels.delete(id);
            }),
      ),
  });
  const dnsClient = Provider.layerDnsClient({
    listRecords: (name) =>
      Effect.sync(() => [...dns].filter(([, value]) => value === name).map(([id]) => ({ id }))),
    createRecord: ({ name }) =>
      Effect.sync(() => {
        const id = `dns-${++sequence}`;
        dns.set(id, name);
        return { id };
      }),
    updateRecord: (id, { name }) =>
      Effect.sync(() => {
        dns.set(id, name);
      }),
    deleteRecord: (id) =>
      Effect.sync(() => {
        dns.delete(id);
      }),
  });
  const provider = Layer.effect(Provider.ManagedEndpointProvider, Provider.make).pipe(
    Layer.provide(Layer.mergeAll(tunnelClient, dnsClient, Intents.layer)),
  );
  const layer = Linker.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(provider, Reservations.layer, Tokens.layer, Dpop.layer)),
    Layer.provideMerge(postgresPolicyFixture),
    Layer.provideMerge(postgresFixture),
    Layer.provide(
      Configuration.layer({
        ...config,
        managedEndpointBaseDomain: "connect.example.test",
        managedEndpointNamespace: "test",
      }),
    ),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(Layer.mock(HookInbox.HookInbox, { clear: () => Effect.void })),
  );
  return {
    layer,
    tunnels,
    dns,
    setDeleteFailure: (value: boolean) => {
      failDelete = value;
    },
  };
}

const abandoned = Effect.gen(function* () {
  const { request, payload } = yield* setup;
  const crypto = yield* Crypto.Crypto;
  const reservation = {
    userId: "user_123",
    environmentId: intent.environmentId,
    challengeId: "challenge-jti",
    proof: Hex.encode(yield* crypto.digest("SHA-256", new TextEncoder().encode(request.proof))),
    attemptId: yield* crypto.randomUUIDv4(),
    assurance: makeAssurance(1800000000),
    managedTunnelsEnabled: true,
  };
  const reservations = yield* Reservations.ConnectLinkReservations;
  const replay = yield* Dpop.DpopProofReplay;
  yield* reservations.exclusive("user_123", () =>
    reservations.reserve(
      reservation,
      Effect.gen(function* () {
        for (const [thumbprint, jti] of [
          [payload.environmentPublicKey, payload.jti],
          ["relay-environment-link-challenge", reservation.challengeId],
        ] as const) {
          if (
            !(yield* replay.consume({
              thumbprint,
              jti,
              iat: payload.iat,
              expiresAt: DateTime.makeUnsafe(payload.exp * 1000),
            }))
          )
            return yield* Effect.die("unexpected replay");
        }
      }),
    ),
  );
  return { request, reservation };
});

const replacementRequest = Effect.fn("test.replacementRequest")(function* (environmentId: string) {
  const { payload, request } = yield* setup;
  const challenge = yield* (yield* Tokens.RelayTokens).issueLinkChallenge({
    userId: "user_123",
    request,
    assurance: makeAssurance(1800000000),
    intent: { ...intent, environmentId, managedTunnelsEnabled: true },
    jti: `challenge-${environmentId}`,
    issuedAtEpochSeconds: 1800000000,
    expiresAtEpochSeconds: 1800000300,
  });
  return {
    ...request,
    proof: signTestJwt(
      {
        ...payload,
        iss: `goat-env:${environmentId}`,
        sub: environmentId,
        environmentId,
        descriptor: { ...payload.descriptor, environmentId },
        challenge,
        jti: `proof-${environmentId}`,
      },
      RELAY_LINK_PROOF_TYP,
      environmentKeyPair.privateKey,
    ),
  };
});

const loseExecution = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const owners = yield* db.$client<{ pid: number }>`SELECT pid FROM pg_locks
    WHERE locktype = 'advisory' AND granted AND objsubid = 1
      AND ((classid::bigint << 32) | objid::bigint) =
        hashtextextended(current_schema() || ':connect-link-execution:user_123', 0)`;
  expect(owners).toHaveLength(1);
  const owner = owners[0];
  if (!owner) return yield* Effect.die("missing isolated execution owner");
  yield* db.$client`SELECT pg_terminate_backend(${owner.pid})`;
  yield* db.$client.withTransaction(
    db.$client`SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':connect-link-execution:user_123', 0))`,
  );
});

const commitOutcome = Effect.fn("test.commitOutcome")(function* (
  provisioned?: Provider.ManagedEndpointProvisioningResult,
) {
  const { request, payload } = yield* setup;
  yield* (yield* Links.EnvironmentLinks).upsert({
    userId: "user_123",
    request,
    proof: payload,
    endpoint: provisioned?.endpoint ?? payload.endpoint,
  });
  const environmentCredential = yield* (yield* Credentials.EnvironmentCredentials).create({
    userId: "user_123",
    accountEpoch: 1,
    environmentId: payload.environmentId,
    environmentPublicKey: payload.environmentPublicKey,
  });
  return {
    environmentId: payload.environmentId,
    endpoint: provisioned?.endpoint ?? payload.endpoint,
    endpointRuntime: provisioned?.runtime ?? null,
    environmentCredential,
  };
});

it.effect("an obsolete checkpoint cannot adopt a replacement allocation at generation zero", () =>
  Effect.gen(function* () {
    const oldCreated = yield* Deferred.make<void>();
    const resumeOld = yield* Deferred.make<void>();
    const replacementCreated = yield* Deferred.make<void>();
    const resumeReplacement = yield* Deferred.make<void>();
    const test = fixture({
      at: "create",
      wait: Deferred.succeed(oldCreated, undefined).pipe(Effect.andThen(Deferred.await(resumeOld))),
      replacementWait: Deferred.succeed(replacementCreated, undefined).pipe(
        Effect.andThen(Deferred.await(resumeReplacement)),
      ),
    });
    return yield* Effect.gen(function* () {
      const { request } = yield* setup;
      const linker = yield* Linker.EnvironmentLinker;
      const old = yield* linker.link({ userId: "user_123", request }).pipe(Effect.forkChild);
      yield* awaitPostgresMilestone(oldCreated, old);
      const allocations = yield* Allocations.ManagedEndpointAllocations;
      const key = { userId: "user_123", environmentId: intent.environmentId };
      const oldAllocation = yield* allocations.get(key);
      yield* loseExecution;
      const replacement = yield* replacementRequest(intent.environmentId);
      const current = yield* linker
        .link({ userId: "user_123", request: replacement })
        .pipe(Effect.forkChild);
      yield* awaitPostgresMilestone(replacementCreated, current);
      const before = yield* allocations.get(key);
      expect(before?.generation).toBe(0);
      expect(before?.incarnationId).not.toBe(oldAllocation?.incarnationId);
      yield* Deferred.succeed(resumeOld, undefined);
      expect((yield* Fiber.await(old))._tag).toBe("Failure");
      expect(yield* allocations.get(key)).toEqual(before);
      yield* Deferred.succeed(resumeReplacement, undefined);
      const result = yield* Fiber.join(current);
      const after = yield* allocations.get(key);
      expect(after?.incarnationId).toBe(before?.incarnationId);
      expect(result.endpointRuntime?.connectorToken).toBe(`connector:${after?.tunnelId}`);
      expect(
        (yield* (yield* Credentials.EnvironmentCredentials).authenticate(
          result.environmentCredential,
        ))._tag,
      ).toBe("Some");
      expect(test.tunnels.size).toBe(1);
      expect(test.tunnels.has(after?.tunnelId ?? "")).toBe(true);
      expect(test.dns.size).toBe(1);
    }).pipe(Effect.provide(test.layer));
  }),
);

it.effect("an obsolete recovery cannot fence a replacement attempt using the same proof", () =>
  Effect.gen(function* () {
    const recoveryPaused = yield* Deferred.make<void>();
    const resumeRecovery = yield* Deferred.make<void>();
    const replacementCreated = yield* Deferred.make<void>();
    const resumeReplacement = yield* Deferred.make<void>();
    const test = fixture({
      at: "create",
      wait: Deferred.succeed(replacementCreated, undefined).pipe(
        Effect.andThen(Deferred.await(resumeReplacement)),
      ),
    });
    return yield* Effect.gen(function* () {
      const { request, reservation } = yield* abandoned;
      const db = yield* RelayDb.RelayDb;
      yield* db.$client`INSERT INTO relay_managed_tunnel_limits (user_id, max_tunnels, created_at, updated_at) VALUES ('user_123', 1, '2026-01-01', '2026-01-01')`;
      const linker = yield* Linker.EnvironmentLinker;
      let paused = false;
      const obsolete = yield* linker.link({ userId: "user_123", request }).pipe(
        Effect.provideService(Statement.CurrentTransformer, (statement) => {
          if (!paused && statement.compile()[0].includes("SELECT pg_advisory_xact_lock")) {
            paused = true;
            return Deferred.succeed(recoveryPaused, undefined).pipe(
              Effect.andThen(Deferred.await(resumeRecovery)),
              Effect.as(statement),
            );
          }
          return Effect.succeed(statement);
        }),
        Effect.forkChild,
      );
      yield* awaitPostgresMilestone(recoveryPaused, obsolete);
      yield* loseExecution;
      const replacement = yield* linker
        .link({ userId: "user_123", request })
        .pipe(Effect.forkChild);
      yield* awaitPostgresMilestone(replacementCreated, replacement);
      const before =
        yield* db.$client`SELECT status, attempt_id FROM relay_connect_link_reservations`;
      expect(before).toHaveLength(1);
      expect(before[0]?.status).toBe("running");
      expect(before[0]?.attempt_id).not.toBe(reservation.attemptId);
      yield* Deferred.succeed(resumeRecovery, undefined);
      expect((yield* Fiber.await(obsolete))._tag).toBe("Failure");
      expect(
        yield* db.$client`SELECT status, attempt_id FROM relay_connect_link_reservations`,
      ).toEqual(before);
      yield* Deferred.succeed(resumeReplacement, undefined);
      const result = yield* Fiber.join(replacement);
      const allocation = yield* (yield* Allocations.ManagedEndpointAllocations).get(reservation);
      expect(result.endpointRuntime?.connectorToken).toBe(`connector:${allocation?.tunnelId}`);
      expect(
        (yield* (yield* Credentials.EnvironmentCredentials).authenticate(
          result.environmentCredential,
        ))._tag,
      ).toBe("Some");
      expect(yield* (yield* Links.EnvironmentLinks).getForUser(reservation)).not.toBeNull();
      expect(test.tunnels.size).toBe(1);
      expect(test.tunnels.has(allocation?.tunnelId ?? "")).toBe(true);
      expect(test.dns.size).toBe(1);
      expect(
        yield* db.$client`SELECT * FROM relay_connect_link_reservations WHERE status IN ('running', 'recovering', 'withdrawn')`,
      ).toHaveLength(0);
    }).pipe(Effect.provide(test.layer));
  }),
);

it.effect(
  "recovery fences completion before cleanup and retains capacity until cleanup finishes",
  () => {
    const test = fixture();
    return Effect.gen(function* () {
      const { reservation } = yield* abandoned;
      const provider = yield* Provider.ManagedEndpointProvider;
      const provisioned = yield* provider.provision({ ...reservation, origin: intent.origin });
      const cleanupEntered = yield* Deferred.make<void>();
      const releaseCleanup = yield* Deferred.make<void>();
      const reservations = yield* Reservations.ConnectLinkReservations;
      const recovery = yield* reservations
        .exclusive("user_123", (assertOwner) =>
          reservations.recover("user_123", assertOwner, (environmentId) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(cleanupEntered, undefined);
              yield* Deferred.await(releaseCleanup);
              yield* provider.deprovision({ userId: "user_123", environmentId });
            }),
          ),
        )
        .pipe(Effect.forkChild);
      yield* awaitPostgresMilestone(cleanupEntered, recovery);
      const db = yield* RelayDb.RelayDb;
      expect(
        (yield* reservations.complete(reservation, commitOutcome(provisioned)).pipe(Effect.result))
          ._tag,
      ).toBe("Failure");
      expect(
        (yield* db.$client`SELECT status FROM relay_connect_link_reservations`)[0]?.status,
      ).toBe("recovering");
      expect(yield* db.$client`SELECT * FROM relay_environment_links`).toHaveLength(0);
      expect(yield* db.$client`SELECT * FROM relay_environment_credentials`).toHaveLength(0);
      const crypto = yield* Crypto.Crypto;
      expect(
        (yield* reservations
          .reserve(
            { ...reservation, attemptId: yield* crypto.randomUUIDv4() },
            Effect.die("reconsumed proof"),
          )
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      yield* db.$client`INSERT INTO relay_managed_tunnel_limits (user_id, max_tunnels, created_at, updated_at) VALUES ('user_123', 1, '2026-01-01', '2026-01-01')`;
      expect(
        (yield* reservations
          .reserve(
            {
              ...reservation,
              challengeId: "different-challenge",
              environmentId: "different-environment",
              attemptId: yield* crypto.randomUUIDv4(),
            },
            Effect.void,
          )
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      yield* Deferred.succeed(releaseCleanup, undefined);
      yield* Fiber.join(recovery);
      expect(test.tunnels.size).toBe(0);
      expect(
        (yield* db.$client`SELECT status FROM relay_connect_link_reservations`)[0]?.status,
      ).toBe("failed");
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect(
  "completion that holds the account lock survives execution loss and subsequent recovery",
  () => {
    const test = fixture();
    return Effect.gen(function* () {
      const { reservation } = yield* abandoned;
      const provider = yield* Provider.ManagedEndpointProvider;
      const provisioned = yield* provider.provision({ ...reservation, origin: intent.origin });
      const reservations = yield* Reservations.ConnectLinkReservations;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const complete = yield* reservations
        .complete(
          reservation,
          commitOutcome(provisioned).pipe(
            Effect.tap(() => Deferred.succeed(entered, undefined)),
            Effect.tap(() => Deferred.await(release)),
          ),
        )
        .pipe(Effect.forkChild);
      yield* awaitPostgresMilestone(entered, complete);
      // The execution owner can disappear while completion owns a different connection.
      expect(
        (yield* reservations
          .exclusive("user_123", (assertOwner) => loseExecution.pipe(Effect.andThen(assertOwner)))
          .pipe(Effect.exit))._tag,
      ).toBe("Failure");
      const result = yield* reservations.exclusive("user_123", (assertOwner) =>
        Effect.gen(function* () {
          const db = yield* RelayDb.RelayDb;
          const lock = yield* db.$client.withTransaction(
            db.$client<{
              acquired: boolean;
            }>`SELECT pg_try_advisory_xact_lock(hashtextextended('user_123', 0)) AS acquired`,
          );
          expect(lock[0]?.acquired).toBe(false);
          const recoveryEntered = yield* Deferred.make<void>();
          const releaseCleanup = yield* Deferred.make<void>();
          const recovery = yield* reservations
            .recover("user_123", assertOwner, (environmentId) =>
              provider
                .deprovision({ userId: "user_123", environmentId })
                .pipe(
                  Effect.andThen(Deferred.succeed(recoveryEntered, undefined)),
                  Effect.andThen(Deferred.await(releaseCleanup)),
                ),
            )
            .pipe(
              // Release completion at the account fence, or after destructive cleanup if that fence is missing.
              Effect.provideService(Statement.CurrentTransformer, (statement) =>
                statement.compile()[0].includes("pg_advisory_xact_lock")
                  ? Deferred.succeed(recoveryEntered, undefined).pipe(Effect.as(statement))
                  : Effect.succeed(statement),
              ),
              Effect.forkChild,
            );
          yield* awaitPostgresMilestone(recoveryEntered, recovery);
          yield* Deferred.succeed(release, undefined);
          const committed = yield* Fiber.join(complete);
          yield* Deferred.succeed(releaseCleanup, undefined);
          yield* Fiber.join(recovery);
          return committed;
        }),
      );
      expect(test.tunnels.size).toBe(1);
      expect(
        (yield* (yield* Credentials.EnvironmentCredentials).authenticate(
          result.environmentCredential,
        ))._tag,
      ).toBe("Some");
      expect(yield* (yield* Links.EnvironmentLinks).getForUser(reservation)).not.toBeNull();
      expect(
        (yield* (yield* RelayDb.RelayDb)
          .$client`SELECT status FROM relay_connect_link_reservations`)[0]?.status,
      ).toBe("complete");
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect.each([false, true])(
  "unlink persists withdrawal and revocation while provisioning is held (same environment=%s)",
  (same) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const test = fixture({
        at: "create",
        wait: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
      });
      return yield* Effect.gen(function* () {
        const { request } = yield* setup;
        const existing = yield* commitOutcome();
        const linker = yield* Linker.EnvironmentLinker;
        const pending = same ? request : yield* replacementRequest("unrelated");
        const worker = yield* linker
          .link({ userId: "user_123", request: pending })
          .pipe(Effect.forkChild);
        yield* awaitPostgresMilestone(entered, worker);
        const withdrawal = yield* unlinkEnvironmentRecord({
          userId: "user_123",
          environmentId: intent.environmentId,
        }).pipe(Effect.result);
        // External cleanup is pending while the execution lock is busy; revocation has committed.
        expect(withdrawal._tag).toBe("Failure");
        const db = yield* RelayDb.RelayDb;
        if (same)
          expect(
            (yield* db.$client`SELECT status FROM relay_connect_link_reservations WHERE environment_id = ${intent.environmentId}`)[0]
              ?.status,
          ).toBe("withdrawn");
        expect(
          yield* (yield* Links.EnvironmentLinks).getForUser({
            userId: "user_123",
            environmentId: intent.environmentId,
          }),
        ).toBeNull();
        expect(
          (yield* (yield* Credentials.EnvironmentCredentials).authenticate(
            existing.environmentCredential,
          ))._tag,
        ).toBe("None");
        yield* Deferred.succeed(release, undefined);
        expect((yield* Fiber.await(worker))._tag).toBe(same ? "Failure" : "Success");
        yield* unlinkEnvironmentRecord({ userId: "user_123", environmentId: intent.environmentId });
        expect(test.tunnels.size).toBe(same ? 0 : 1);
        if (same)
          expect(
            yield* db.$client`SELECT * FROM relay_environment_credentials WHERE revoked_at IS NULL`,
          ).toHaveLength(0);
      }).pipe(Effect.provide(test.layer));
    }),
);

it.effect.each([false, true])(
  "worker loss after reservation (provisioned=%s) recovers before admitting a different environment at quota one",
  (provisioned) => {
    const test = fixture();
    return Effect.gen(function* () {
      const { reservation } = yield* abandoned;
      const db = yield* RelayDb.RelayDb;
      yield* db.$client`INSERT INTO relay_managed_tunnel_limits (user_id, max_tunnels, created_at, updated_at) VALUES ('user_123', 1, '2026-01-01', '2026-01-01')`;
      const provider = yield* Provider.ManagedEndpointProvider;
      if (provisioned) yield* provider.provision({ ...reservation, origin: intent.origin });
      const request = yield* replacementRequest("replacement");
      const result = yield* (yield* Linker.EnvironmentLinker).link({ userId: "user_123", request });
      expect(test.tunnels.size).toBe(1);
      expect(
        yield* db.$client`SELECT * FROM relay_connect_link_reservations WHERE status = 'running'`,
      ).toHaveLength(0);
      expect(
        (yield* db.$client`SELECT status FROM relay_connect_link_reservations WHERE challenge_id = 'challenge-jti'`)[0]
          ?.status,
      ).toBe("failed");
      expect(
        (yield* (yield* Credentials.EnvironmentCredentials).authenticate(
          result.environmentCredential,
        ))._tag,
      ).toBe("Some");
      expect(
        (yield* (yield* Reservations.ConnectLinkReservations)
          .complete(reservation, Effect.die("obsolete commit ran"))
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect(
  "failed cleanup retains quota and a later request resumes cleanup before provisioning",
  () => {
    const test = fixture();
    return Effect.gen(function* () {
      const { reservation } = yield* abandoned;
      const provider = yield* Provider.ManagedEndpointProvider;
      yield* provider.provision({ ...reservation, origin: intent.origin });
      const db = yield* RelayDb.RelayDb;
      yield* db.$client`INSERT INTO relay_managed_tunnel_limits (user_id, max_tunnels, created_at, updated_at) VALUES ('user_123', 1, '2026-01-01', '2026-01-01')`;
      const request = yield* replacementRequest("replacement");
      const linker = yield* Linker.EnvironmentLinker;
      test.setDeleteFailure(true);
      expect((yield* linker.link({ userId: "user_123", request }).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect(test.tunnels.size).toBe(1);
      expect(
        yield* db.$client`SELECT * FROM relay_connect_link_reservations WHERE status = 'recovering'`,
      ).toHaveLength(1);
      expect(yield* db.$client`SELECT * FROM relay_environment_credentials`).toHaveLength(0);
      test.setDeleteFailure(false);
      const result = yield* linker.link({ userId: "user_123", request });
      expect(test.tunnels.size).toBe(1);
      expect(
        (yield* (yield* Credentials.EnvironmentCredentials).authenticate(
          result.environmentCredential,
        ))._tag,
      ).toBe("Some");
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect(
  "withdrawn operation cleanup and late completion cannot remove a replacement connector or credential",
  () => {
    const test = fixture();
    return Effect.gen(function* () {
      const { reservation } = yield* abandoned;
      const provider = yield* Provider.ManagedEndpointProvider;
      yield* provider.provision({ ...reservation, origin: intent.origin });
      const oldTarget = yield* provider.prepareDeprovision(reservation);
      const reservations = yield* Reservations.ConnectLinkReservations;
      yield* reservations.withdraw(reservation, Effect.void);
      const request = yield* replacementRequest(intent.environmentId);
      const current = yield* (yield* Linker.EnvironmentLinker).link({
        userId: "user_123",
        request,
      });
      const currentTarget = yield* provider.prepareDeprovision(reservation);
      expect(currentTarget?.tunnelId).not.toBe(oldTarget?.tunnelId);
      expect(yield* provider.deprovision({ ...reservation, target: oldTarget })).toBe(false);
      expect(
        (yield* reservations
          .complete(reservation, Effect.die("obsolete commit ran"))
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(yield* provider.prepareDeprovision(reservation)).toEqual(currentTarget);
      expect(test.tunnels.has(currentTarget?.tunnelId ?? "")).toBe(true);
      expect(current.endpointRuntime?.connectorToken).toBe(`connector:${currentTarget?.tunnelId}`);
      expect(
        (yield* (yield* Credentials.EnvironmentCredentials).authenticate(
          current.environmentCredential,
        ))._tag,
      ).toBe("Some");
      expect(yield* (yield* Links.EnvironmentLinks).getForUser(reservation)).not.toBeNull();
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect(
  "an active execution cannot be reclaimed before its owner releases the transaction lock",
  () => {
    const test = fixture();
    return Effect.gen(function* () {
      const { reservation } = yield* abandoned;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const reservations = yield* Reservations.ConnectLinkReservations;
      const owner = yield* reservations
        .exclusive("user_123", () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          }),
        )
        .pipe(Effect.forkChild);
      yield* awaitPostgresMilestone(entered, owner);
      const request = yield* replacementRequest("replacement");
      expect(
        (yield* (yield* Linker.EnvironmentLinker)
          .link({ userId: "user_123", request })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(test.tunnels.size).toBe(0);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(owner);
      yield* (yield* Linker.EnvironmentLinker).link({ userId: "user_123", request });
      expect(
        (yield* reservations
          .complete(reservation, Effect.die("obsolete commit ran"))
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect.each(["create", "token"] as const)(
  "a resumed obsolete worker cannot compensate a newer relink after losing its database connection at %s",
  (at) =>
    Effect.gen(function* () {
      const provisioned = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const test = fixture({
        at,
        wait: Deferred.succeed(provisioned, undefined).pipe(Effect.andThen(Deferred.await(resume))),
      });
      return yield* Effect.gen(function* () {
        const { request } = yield* setup;
        const linker = yield* Linker.EnvironmentLinker;
        const oldWorker = yield* linker
          .link({ userId: "user_123", request })
          .pipe(Effect.forkChild);
        yield* awaitPostgresMilestone(provisioned, oldWorker);
        const db = yield* RelayDb.RelayDb;
        const owners = yield* db.$client<{ pid: number }>`SELECT pid FROM pg_locks
        WHERE locktype = 'advisory' AND granted AND objsubid = 1
          AND ((classid::bigint << 32) | objid::bigint) =
            hashtextextended(current_schema() || ':connect-link-execution:user_123', 0)`;
        expect(owners).toHaveLength(1);
        const owner = owners[0];
        if (!owner) return yield* Effect.die("missing isolated execution owner");
        yield* db.$client`SELECT pg_terminate_backend(${owner.pid})`;
        yield* db.$client.withTransaction(
          db.$client`SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':connect-link-execution:user_123', 0))`,
        );
        yield* (yield* Reservations.ConnectLinkReservations).withdraw(
          {
            userId: "user_123",
            environmentId: intent.environmentId,
          },
          Effect.void,
        );
        const replacement = yield* replacementRequest(intent.environmentId);
        const current = yield* linker.link({ userId: "user_123", request: replacement });
        const provider = yield* Provider.ManagedEndpointProvider;
        const target = yield* provider.prepareDeprovision({
          userId: "user_123",
          environmentId: intent.environmentId,
        });
        yield* Deferred.succeed(resume, undefined);
        expect((yield* Fiber.await(oldWorker))._tag).toBe("Failure");
        expect(
          yield* provider.prepareDeprovision({
            userId: "user_123",
            environmentId: intent.environmentId,
          }),
        ).toEqual(target);
        expect(test.tunnels.size).toBe(1);
        expect(current.endpointRuntime?.connectorToken).toBe(`connector:${target?.tunnelId}`);
        expect(
          (yield* (yield* Credentials.EnvironmentCredentials).authenticate(
            current.environmentCredential,
          ))._tag,
        ).toBe("Some");
        expect(
          yield* (yield* Links.EnvironmentLinks).getForUser({
            userId: "user_123",
            environmentId: intent.environmentId,
          }),
        ).not.toBeNull();
      }).pipe(Effect.provide(test.layer));
    }),
);

it.effect(
  "recovery resumes an identical one-use proof with a new attempt and rejects the old attempt",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const test = fixture({
        at: "create",
        wait: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
      });
      return yield* Effect.gen(function* () {
        const { request, reservation } = yield* abandoned;
        const linker = yield* Linker.EnvironmentLinker;
        const retry = yield* linker.link({ userId: "user_123", request }).pipe(Effect.forkChild);
        yield* awaitPostgresMilestone(entered, retry);
        const db = yield* RelayDb.RelayDb;
        const row =
          (yield* db.$client`SELECT status, attempt_id FROM relay_connect_link_reservations`)[0];
        expect(row?.status).toBe("running");
        expect(row?.attempt_id).not.toBe(reservation.attemptId);
        const reservations = yield* Reservations.ConnectLinkReservations;
        expect(
          (yield* reservations.complete(reservation, commitOutcome()).pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(yield* db.$client`SELECT * FROM relay_environment_credentials`).toHaveLength(0);
        yield* Deferred.succeed(release, undefined);
        const current = yield* Fiber.join(retry);
        expect(yield* linker.link({ userId: "user_123", request })).toEqual(current);
        expect(test.tunnels.size).toBe(1);
        expect(
          yield* (yield* RelayDb.RelayDb).$client`SELECT * FROM relay_dpop_proofs`,
        ).toHaveLength(2);
      }).pipe(Effect.provide(test.layer));
    }),
);

it.effect(
  "failed compensation after credential persistence failure is resumed by the identical signed request",
  () => {
    const test = fixture();
    return Effect.gen(function* () {
      const { request } = yield* setup;
      const db = yield* RelayDb.RelayDb;
      yield* db.$client`ALTER TABLE relay_environment_credentials ADD CONSTRAINT reject_issuance CHECK (false) NOT VALID`;
      const linker = yield* Linker.EnvironmentLinker;
      test.setDeleteFailure(true);
      expect((yield* linker.link({ userId: "user_123", request }).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect(
        yield* db.$client`SELECT * FROM relay_connect_link_reservations WHERE status = 'running'`,
      ).toHaveLength(1);
      expect(yield* db.$client`SELECT * FROM relay_environment_links`).toHaveLength(0);
      expect(yield* db.$client`SELECT * FROM relay_environment_credentials`).toHaveLength(0);
      yield* db.$client`ALTER TABLE relay_environment_credentials DROP CONSTRAINT reject_issuance`;
      test.setDeleteFailure(false);
      const current = yield* linker.link({ userId: "user_123", request });
      expect(test.tunnels.size).toBe(1);
      expect(yield* db.$client`SELECT * FROM relay_dpop_proofs`).toHaveLength(2);
      expect(yield* linker.link({ userId: "user_123", request })).toEqual(current);
      expect(
        (yield* (yield* Credentials.EnvironmentCredentials).authenticate(
          current.environmentCredential,
        ))._tag,
      ).toBe("Some");
    }).pipe(Effect.provide(test.layer));
  },
);
