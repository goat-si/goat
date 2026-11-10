// @effect-diagnostics globalDate:off - Token times are computed from a fixed epoch below.
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { Env } from "../src/env.ts";
import { OidcError, provider, verifyIdToken } from "../src/oidc.ts";
import { type FakeIssuer, signIdToken, startFakeIssuer } from "./fakeIssuer.ts";

const env = {
  GOOGLE_CLIENT_ID: "client",
  GOOGLE_CLIENT_SECRET: "secret",
  LOGIN_SIGNING_KEY: "",
  GOOGLE_ISSUER: "http://127.0.0.1:9999",
  GOOGLE_DISCOVERY: "http://127.0.0.1:9999/.well-known/openid-configuration",
} as unknown as Env;

describe("identity provider selection (Accounts v1.1: the fake issuer counts only on localhost)", () => {
  it("a deployed request uses Google even when a test issuer is configured", () => {
    const chosen = provider(env, new URL("https://pen-login.pos090001.workers.dev/device"));
    expect(chosen.discovery).toBe("https://accounts.google.com/.well-known/openid-configuration");
    expect(chosen.issuers).toEqual(["https://accounts.google.com", "accounts.google.com"]);
  });

  it("a localhost request uses the test issuer only when the discovery URL is local too", () => {
    expect(provider(env, new URL("http://127.0.0.1:8787/device")).issuers).toEqual([
      "http://127.0.0.1:9999",
    ]);
    const remote = {
      ...env,
      GOOGLE_DISCOVERY: "https://evil.example/.well-known/openid-configuration",
    } as Env;
    expect(provider(remote, new URL("http://127.0.0.1:8787/device")).issuers).toEqual([
      "https://accounts.google.com",
      "accounts.google.com",
    ]);
  });
});

describe("id_token verification against Google's issuer list", () => {
  const NOW_MS = 1_794_300_000_000;
  const now = NOW_MS / 1000;
  let issuer: FakeIssuer;
  beforeAll(async () => {
    issuer = await startFakeIssuer();
  });
  afterAll(async () => {
    await issuer?.close();
  });

  function cache() {
    const rows = new Map<string, { body: string; fetched_at: number }>();
    return {
      jwks: (url: string) => rows.get(url) ?? null,
      saveJwks: (url: string, body: string, at: number) =>
        void rows.set(url, { body, fetched_at: at }),
    };
  }

  async function verify(claims: Record<string, unknown>) {
    const google = provider(
      env,
      new URL("https://pen-login.pos090001.workers.dev/v1/auth/google/callback"),
    );
    const found = {
      authorization: `${issuer.url}/authorize`,
      token: `${issuer.url}/token`,
      jwks: `${issuer.url}/jwks`,
    };
    const key = issuer.published[0];
    if (!key) throw new Error("no key");
    const token = signIdToken(
      {
        sub: "1",
        email: "p@example.com",
        email_verified: true,
        nonce: "n",
        iat: now,
        exp: now + 3600,
        ...claims,
      },
      key,
    );
    return verifyIdToken(cache(), found, google, token, { nonce: "n", now: NOW_MS });
  }

  it("accepts iss accounts.google.com with or without the https scheme, and nothing else", async () => {
    expect(await verify({ iss: "accounts.google.com", aud: "client" })).toEqual({
      sub: "1",
      email: "p@example.com",
    });
    expect(await verify({ iss: "https://accounts.google.com", aud: "client" })).toEqual({
      sub: "1",
      email: "p@example.com",
    });
    await expect(
      verify({ iss: "http://accounts.google.com", aud: "client" }),
    ).rejects.toBeInstanceOf(OidcError);
  });

  it("accepts an array aud only when it holds the client id and azp names the client", async () => {
    const iss = "https://accounts.google.com";
    expect(await verify({ iss, aud: ["client", "other"], azp: "client" })).toEqual({
      sub: "1",
      email: "p@example.com",
    });
    await expect(verify({ iss, aud: ["client", "other"], azp: "other" })).rejects.toBeInstanceOf(
      OidcError,
    );
    await expect(verify({ iss, aud: ["client", "other"] })).rejects.toBeInstanceOf(OidcError);
    await expect(verify({ iss, aud: ["other"], azp: "client" })).rejects.toBeInstanceOf(OidcError);
  });
});
