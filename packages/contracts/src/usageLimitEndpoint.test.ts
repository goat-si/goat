import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { UsageLimitSourceSnapshot } from "./providerUsageLimits.ts";
import { ServerProviderAuth } from "./server.ts";

const source = {
  id: "hub",
  kind: "cliproxy",
  label: "hub",
  checkedAt: "2026-11-13T12:00:00.000Z",
  accounts: [],
} as const;
const auth = { status: "authenticated" } as const;

const { origin: _origin, ...olderSourceFields } = UsageLimitSourceSnapshot.fields;
const { endpoint: _endpoint, ...olderAuthFields } = ServerProviderAuth.fields;
// What a client or server from before these fields decodes with.
const decodeOlderSource = Schema.decodeUnknownSync(Schema.Struct(olderSourceFields));
const decodeOlderAuth = Schema.decodeUnknownSync(Schema.Struct(olderAuthFields));
const decodeSource = Schema.decodeUnknownSync(UsageLimitSourceSnapshot);
const decodeAuth = Schema.decodeUnknownSync(ServerProviderAuth);

it("an older peer reads a hub origin and an instance endpoint as absent", () => {
  expect(decodeOlderSource({ ...source, origin: "https://hub.test" })).toEqual(source);
  expect(decodeOlderAuth({ ...auth, endpoint: "https://hub.test" })).toEqual(auth);
});

it("a newer peer reads an older snapshot without origin or endpoint", () => {
  expect(decodeSource(source).origin).toBeUndefined();
  expect(decodeAuth(auth).endpoint).toBeUndefined();
  expect(decodeSource({ ...source, origin: "https://hub.test" }).origin).toBe("https://hub.test");
  expect(decodeAuth({ ...auth, endpoint: "http://127.0.0.1:4318" }).endpoint).toBe(
    "http://127.0.0.1:4318",
  );
});

it("rejects a blank origin or endpoint", () => {
  expect(() => decodeSource({ ...source, origin: " " })).toThrow();
  expect(() => decodeAuth({ ...auth, endpoint: "" })).toThrow();
});
