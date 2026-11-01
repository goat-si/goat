import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { HttpClient, HttpClientResponse } from "effect/http";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as TestClock from "effect/testing/TestClock";
import type { BoatSandboxId } from "@goat/contracts";

import * as BoatClient from "./BoatClient.ts";

const KEY = "boat_test_key_not_real";
const ID = "bx_23456789" as BoatSandboxId;
const HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOv8eZbJtFiAHk3Fp2Kq";

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

const bodyOf = (request: HttpClientRequest.HttpClientRequest): unknown =>
  request.body._tag === "Uint8Array"
    ? JSON.parse(new TextDecoder().decode(request.body.body))
    : undefined;

/** A Boat stand-in: answers each request with the next queued response. */
const fakeBoat = (responses: ReadonlyArray<() => Response>) => {
  const seen: Array<Seen> = [];
  let index = 0;
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      seen.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: bodyOf(request),
      });
      const next = responses[Math.min(index, responses.length - 1)]!;
      index += 1;
      return HttpClientResponse.fromWeb(request, next());
    }),
  );
  return { seen, client };
};

const withClient = <A, E>(
  client: HttpClient.HttpClient,
  use: (boat: BoatClient.BoatClient["Service"]) => Effect.Effect<A, E>,
) =>
  BoatClient.make.pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.flatMap(use));

const created = () =>
  Response.json(
    { ok: true, type: "sandbox.created", sandbox: { id: ID, name: "x", state: "provisioning" } },
    { status: 202 },
  );

describe("BoatClient", () => {
  it.effect("creates with the bearer key, noEnv and one Idempotency-Key across retries", () =>
    Effect.gen(function* () {
      const boat = fakeBoat([
        () => new Response("unavailable", { status: 503 }),
        () =>
          Response.json(
            { ok: false, status: 409, code: "idempotency_in_progress", message: "busy" },
            { status: 409 },
          ),
        created,
      ]);
      const fiber = yield* withClient(boat.client, (client) =>
        client.create(KEY, { type: "small", ttlSeconds: 3600 }, "key-1"),
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("30 seconds");
      const sandbox = yield* Fiber.join(fiber);
      expect(sandbox).toEqual({ id: ID, name: "x", state: "provisioning" });
      expect(boat.seen).toHaveLength(3);
      for (const request of boat.seen) {
        expect(request.method).toBe("POST");
        expect(request.url).toBe("https://boat.dev/api/v1/sandboxes");
        expect(request.headers["authorization"]).toBe(`Bearer ${KEY}`);
        expect(request.headers["idempotency-key"]).toBe("key-1");
        expect(request.body).toEqual({ type: "small", ttlSeconds: 3600, noEnv: true });
      }
    }),
  );

  it.effect("maps Boat failures to safe reasons that never carry the key", () =>
    Effect.gen(function* () {
      const cases = [
        [401, {}, "invalid_key"],
        [402, {}, "billing_required"],
        [403, { code: "machine_class_plan_required" }, "scope_denied"],
        [404, {}, "not_found"],
        [409, { code: "snapshot_data_expired" }, "snapshot_expired"],
        [409, { code: "invalid_state" }, "conflict"],
        [429, {}, "limit_reached"],
      ] as const;
      for (const [status, body, reason] of cases) {
        const boat = fakeBoat([
          () => Response.json({ ok: false, status, message: `echo ${KEY}`, ...body }, { status }),
        ]);
        const error = yield* withClient(boat.client, (client) => client.get(KEY, ID)).pipe(
          Effect.flip,
        );
        expect(error.reason, String(status)).toBe(reason);
        expect(JSON.stringify(error) + error.message).not.toContain(KEY);
      }
    }),
  );

  it.effect("rejects an unknown sandbox state instead of inventing one", () =>
    Effect.gen(function* () {
      const boat = fakeBoat([
        () =>
          Response.json({ ok: true, type: "sandbox.info", sandbox: { id: ID, state: "melting" } }),
      ]);
      const error = yield* withClient(boat.client, (client) => client.get(KEY, ID)).pipe(
        Effect.flip,
      );
      expect(error.reason).toBe("protocol_error");
    }),
  );

  it.effect("confirms deletes with the sandbox id header", () =>
    Effect.gen(function* () {
      const boat = fakeBoat([
        () => Response.json({ ok: true, type: "sandbox.deleting" }, { status: 202 }),
      ]);
      yield* withClient(boat.client, (client) => client.remove(KEY, ID));
      expect(boat.seen[0]).toMatchObject({
        method: "DELETE",
        url: `https://boat.dev/api/v1/sandboxes/${ID}`,
      });
      expect(boat.seen[0]!.headers["x-ascii-confirm-delete"]).toBe(ID);
    }),
  );

  it.effect("authorizes the public key and returns a pinned endpoint", () =>
    Effect.gen(function* () {
      const boat = fakeBoat([
        () =>
          Response.json({
            ok: true,
            type: "ssh_key.configured",
            machineIp: "203.0.113.10",
            sshUser: "user",
            hostKey: HOST_KEY,
          }),
      ]);
      const endpoint = yield* withClient(boat.client, (client) =>
        client.authorizeSshKey(KEY, ID, "ssh-ed25519 AAAAPUBLIC goat-cloud"),
      );
      expect(endpoint).toEqual({ host: "203.0.113.10", port: 22, user: "user", hostKey: HOST_KEY });
      expect(boat.seen[0]!.body).toEqual({ key: "ssh-ed25519 AAAAPUBLIC goat-cloud" });
    }),
  );
});

describe("parseBoatSshEndpoint", () => {
  it("prefers the forwarded sshEndpoint over machineIp", () => {
    expect(
      BoatClient.parseBoatSshEndpoint({
        ok: true,
        machineIp: "203.0.113.10",
        sshEndpoint: "198.51.100.7:22001",
        hostKey: `${HOST_KEY} root@machine`,
      }),
    ).toEqual({ host: "198.51.100.7", port: 22001, user: "user", hostKey: HOST_KEY });
  });

  it("refuses to connect without a valid host key or address", () => {
    for (const value of [
      { ok: true as const, machineIp: "203.0.113.10" },
      { ok: true as const, machineIp: "203.0.113.10", hostKey: "not a key" },
      { ok: true as const, machineIp: "203.0.113.10", hostKey: `${HOST_KEY}\nHost *` },
      { ok: true as const, machineIp: "evil host -oProxyCommand=x", hostKey: HOST_KEY },
      { ok: true as const, sshEndpoint: "198.51.100.7:99999", hostKey: HOST_KEY },
      { ok: true as const, machineIp: null, hostKey: HOST_KEY },
      { ok: true as const, machineIp: "203.0.113.10", sshUser: "root; rm", hostKey: HOST_KEY },
    ]) {
      expect(BoatClient.parseBoatSshEndpoint(value), JSON.stringify(value)).toBeNull();
    }
  });
});
