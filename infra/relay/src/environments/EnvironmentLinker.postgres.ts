import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { RELAY_LINK_PROOF_TYP } from "@goat/shared/relayJwt";
import * as RelayDb from "../db.ts";
import * as Linker from "./EnvironmentLinker.ts";
import { signTestJwt, environmentKeyPair } from "./EnvironmentLinker.testkit.ts";
import { layer, setup } from "./EnvironmentLinker.postgres.testkit.ts";

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
