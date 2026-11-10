import { describe, expect, it } from "vite-plus/test";
import type { Env } from "../src/env.ts";
import { provider } from "../src/oidc.ts";

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
