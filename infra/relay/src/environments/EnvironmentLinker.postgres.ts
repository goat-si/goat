import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { RELAY_LINK_PROOF_TYP } from "@goat/shared/relayJwt";
import * as RelayDb from "../db.ts";
import * as RelayConfiguration from "../Config.ts";
import * as ConnectAccounts from "../auth/ConnectAccounts.ts";
import * as DpopProofs from "../auth/DpopProofs.ts";
import * as RelayTokens from "../auth/RelayTokens.ts";
import { postgresFixture } from "../auth/connectPostgres.testkit.ts";
import * as Reservations from "./ConnectLinkReservations.ts";
import * as Linker from "./EnvironmentLinker.ts";
import * as Links from "./EnvironmentLinks.ts";
import * as Credentials from "./EnvironmentCredentials.ts";
import * as Provider from "./ManagedEndpointProvider.ts";
import {
  config,
  makeRequest,
  signTestJwt,
  environmentKeyPair,
  intent,
  makeAssurance,
} from "./EnvironmentLinker.testkit.ts";

function layer(calls: string[], failProvision = false, expireDuringProvision = false) {
  return Linker.layer.pipe(
    Layer.provideMerge(Reservations.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        Links.layer,
        Credentials.layer,
        RelayTokens.layer,
        DpopProofs.layer,
        ConnectAccounts.layer,
      ),
    ),
    Layer.provideMerge(postgresFixture),
    Layer.provide(RelayConfiguration.layer(config)),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(
      Layer.mock(Provider.ManagedEndpointProvider, {
        provision: () =>
          Effect.gen(function* () {
            calls.push("provision");
            if (expireDuringProvision) yield* TestClock.adjust("10 minutes");
            if (failProvision)
              return yield* new Provider.ManagedEndpointProvisioningFailed({
                userId: "user_123",
                environmentId: "env-link-test",
                stage: "ensure-tunnel",
                cause: "provider unavailable",
              });
            return {
              endpoint: {
                providerKind: "cloudflare_tunnel" as const,
                httpBaseUrl: "https://managed.example.test",
                wsBaseUrl: "wss://managed.example.test",
              },
              runtime: { providerKind: "cloudflare_tunnel" as const, connectorToken: "connector" },
            };
          }),
        deprovision: () =>
          Effect.sync(() => {
            calls.push("deprovision");
            return true;
          }),
      }),
    ),
  );
}
const setup = Effect.gen(function* () {
  yield* TestClock.setTime(1800000000000);
  yield* (yield* ConnectAccounts.ConnectAccounts).authorize("user_123");
  const fixture = yield* makeRequest;
  const challenge = yield* (yield* RelayTokens.RelayTokens).issueLinkChallenge({
    userId: "user_123",
    request: {
      notificationsEnabled: false,
      liveActivitiesEnabled: false,
      managedTunnelsEnabled: true,
    },
    assurance: makeAssurance(1800000000),
    intent: { ...intent, managedTunnelsEnabled: true },
    jti: "challenge-jti",
    issuedAtEpochSeconds: 1800000000,
    expiresAtEpochSeconds: 1800000300,
  });
  const payload = { ...fixture.payload, challenge };
  return {
    payload,
    request: {
      ...fixture.request,
      managedTunnelsEnabled: true,
      proof: signTestJwt(payload, RELAY_LINK_PROOF_TYP, environmentKeyPair.privateKey),
    },
  };
});

it.effect("different host proofs sharing one challenge reserve exactly one durable link", () => {
  const calls: string[] = [];
  return Effect.gen(function* () {
    const { request, payload } = yield* setup;
    const linker = yield* Linker.EnvironmentLinker;
    const other = {
      ...request,
      proof: signTestJwt(
        { ...payload, jti: "another-proof" },
        RELAY_LINK_PROOF_TYP,
        environmentKeyPair.privateKey,
      ),
    };
    const results = yield* Effect.all(
      [
        linker.link({ userId: "user_123", request }).pipe(Effect.result),
        linker.link({ userId: "user_123", request: other }).pipe(Effect.result),
      ],
      { concurrency: "unbounded" },
    );
    expect(results.filter((r) => r._tag === "Success")).toHaveLength(1);
    const db = yield* RelayDb.RelayDb;
    expect(
      (yield* db.$client`SELECT * FROM relay_connect_link_reservations WHERE status = 'complete'`)
        .length,
    ).toBe(1);
    expect(
      (yield* db.$client`SELECT * FROM relay_environment_credentials WHERE revoked_at IS NULL`)
        .length,
    ).toBe(1);
  }).pipe(Effect.provide(layer(calls)));
});

it.effect(
  "lost link response returns the committed outcome without new credentials or provisioning",
  () => {
    const calls: string[] = [];
    return Effect.gen(function* () {
      const { request } = yield* setup;
      const linker = yield* Linker.EnvironmentLinker;
      const first = yield* linker.link({ userId: "user_123", request });
      const before = [...calls];
      expect(yield* linker.link({ userId: "user_123", request })).toEqual(first);
      expect(calls).toEqual(before);
      const db = yield* RelayDb.RelayDb;
      const stored = yield* db.$client<{
        outcome: string;
      }>`SELECT outcome FROM relay_connect_link_reservations`;
      expect(stored[0]?.outcome).not.toContain(first.environmentCredential);
    }).pipe(Effect.provide(layer(calls)));
  },
);

it.effect.each(["relay_environment_links", "relay_environment_credentials"] as const)(
  "%s persistence failure rolls back issuance and allows the reserved proof to retry",
  (table) => {
    const calls: string[] = [];
    return Effect.gen(function* () {
      const { request } = yield* setup;
      const db = yield* RelayDb.RelayDb;
      yield* db.$client.unsafe(
        `ALTER TABLE ${table} ADD CONSTRAINT reject_write CHECK (false) NOT VALID`,
      );
      const linker = yield* Linker.EnvironmentLinker;
      expect((yield* linker.link({ userId: "user_123", request }).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect((yield* db.$client`SELECT * FROM relay_environment_links`).length).toBe(0);
      expect((yield* db.$client`SELECT * FROM relay_environment_credentials`).length).toBe(0);
      expect(
        (yield* db.$client`SELECT * FROM relay_connect_link_reservations WHERE status = 'failed'`)
          .length,
      ).toBe(1);
      yield* db.$client.unsafe(`ALTER TABLE ${table} DROP CONSTRAINT reject_write`);
      yield* linker.link({ userId: "user_123", request });
      expect(
        (yield* db.$client`SELECT * FROM relay_connect_link_reservations WHERE status = 'complete'`)
          .length,
      ).toBe(1);
    }).pipe(Effect.provide(layer(calls)));
  },
);

it.effect.each([
  "environmentId",
  "environmentPublicKey",
  "origin",
  "managedTunnelsEnabled",
] as const)(
  "a signed target/key/origin/capability mismatch (%s) has zero persistence or provider effects",
  (field) => {
    const calls: string[] = [];
    return Effect.gen(function* () {
      const { request, payload } = yield* setup;
      const changed =
        field === "origin"
          ? { origin: { localHttpHost: "127.0.0.1", localHttpPort: 4999 } }
          : field === "managedTunnelsEnabled"
            ? {}
            : { [field]: "wrong-target" };
      const proof = signTestJwt(
        { ...payload, ...changed },
        RELAY_LINK_PROOF_TYP,
        environmentKeyPair.privateKey,
      );
      const result = yield* (yield* Linker.EnvironmentLinker)
        .link({
          userId: "user_123",
          request: {
            ...request,
            proof,
            ...(field === "managedTunnelsEnabled" ? { managedTunnelsEnabled: false } : {}),
          },
        })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(calls).toEqual([]);
      expect(
        (yield* (yield* RelayDb.RelayDb).$client`SELECT * FROM relay_connect_link_reservations`)
          .length,
      ).toBe(0);
    }).pipe(Effect.provide(layer(calls)));
  },
);

it.effect("provider failure compensates the reserved operation and releases its quota", () => {
  const calls: string[] = [];
  return Effect.gen(function* () {
    const { request } = yield* setup;
    expect(
      (yield* (yield* Linker.EnvironmentLinker)
        .link({ userId: "user_123", request })
        .pipe(Effect.result))._tag,
    ).toBe("Failure");
    expect(calls).toEqual(["provision", "deprovision"]);
    expect(
      (yield* (yield* RelayDb.RelayDb)
        .$client`SELECT * FROM relay_connect_link_reservations WHERE status = 'running'`).length,
    ).toBe(0);
  }).pipe(Effect.provide(layer(calls, true)));
});

it.effect.each(["relay_dpop_proofs", "relay_connect_link_reservations"] as const)(
  "%s reservation failure leaves no consumed challenge or provisioned endpoint",
  (table) => {
    const calls: string[] = [];
    return Effect.gen(function* () {
      const { request } = yield* setup;
      const db = yield* RelayDb.RelayDb;
      yield* db.$client.unsafe(
        `ALTER TABLE ${table} ADD CONSTRAINT reject_reservation CHECK (false) NOT VALID`,
      );
      expect(
        (yield* (yield* Linker.EnvironmentLinker)
          .link({ userId: "user_123", request })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(calls).toEqual([]);
      expect((yield* db.$client`SELECT * FROM relay_dpop_proofs`).length).toBe(0);
      expect((yield* db.$client`SELECT * FROM relay_connect_link_reservations`).length).toBe(0);
    }).pipe(Effect.provide(layer(calls)));
  },
);

it.effect(
  "freshness expiring during provisioning cannot commit a link or bootstrap credential",
  () => {
    const calls: string[] = [];
    return Effect.gen(function* () {
      const { request } = yield* setup;
      expect(
        (yield* (yield* Linker.EnvironmentLinker)
          .link({ userId: "user_123", request })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(calls).toEqual(["provision", "deprovision"]);
      const db = yield* RelayDb.RelayDb;
      expect((yield* db.$client`SELECT * FROM relay_environment_links`).length).toBe(0);
      expect((yield* db.$client`SELECT * FROM relay_environment_credentials`).length).toBe(0);
    }).pipe(Effect.provide(layer(calls, false, true)));
  },
);

it.effect(
  "a failed completion receipt rolls back link and credential writes and permits retry after compensation",
  () => {
    const calls: string[] = [];
    return Effect.gen(function* () {
      const { request } = yield* setup;
      const db = yield* RelayDb.RelayDb;
      yield* db.$client`ALTER TABLE relay_connect_link_reservations ADD CONSTRAINT reject_completion CHECK (status <> 'complete') NOT VALID`;
      const linker = yield* Linker.EnvironmentLinker;
      expect((yield* linker.link({ userId: "user_123", request }).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect(calls).toEqual(["provision", "deprovision"]);
      expect((yield* db.$client`SELECT * FROM relay_environment_links`).length).toBe(0);
      expect((yield* db.$client`SELECT * FROM relay_environment_credentials`).length).toBe(0);
      yield* db.$client`ALTER TABLE relay_connect_link_reservations DROP CONSTRAINT reject_completion`;
      yield* linker.link({ userId: "user_123", request });
      expect(
        (yield* db.$client`SELECT * FROM relay_connect_link_reservations WHERE status = 'complete'`)
          .length,
      ).toBe(1);
    }).pipe(Effect.provide(layer(calls)));
  },
);
