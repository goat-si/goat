import { expect, it } from "vite-plus/test";
import { EnvironmentId } from "@goat/contracts";
import { createVoiceGrantStorage } from "./voiceGrantStorage";

it("stores a device grant and invalidates restored or revoked grants", async () => {
  let secret: string | null = null;
  let marker = "";
  let id = 0;
  const storage = createVoiceGrantStorage({
    readSecret: async () => secret,
    writeSecret: (value) => {
      secret = value;
    },
    readMarker: () => marker,
    writeMarker: (value) => {
      marker = value;
    },
    newId: () => `grant-${++id}`,
  });
  expect(await storage.read()).toBeNull();
  const first = storage.choose(EnvironmentId.make("env"));
  expect(await storage.read()).toEqual(first);
  const restored = secret;
  storage.choose(null);
  secret = restored;
  expect(await storage.read()).toBeNull();
  expect(storage.choose(EnvironmentId.make("env"))?.id).not.toBe(first?.id);
});

it("leaves a previous grant invalid if updating secure storage fails", async () => {
  let secret: string | null = null;
  let marker = "";
  let fail = false;
  const storage = createVoiceGrantStorage({
    readSecret: async () => secret,
    writeSecret: (value) => {
      if (fail) throw new Error("unavailable");
      secret = value;
    },
    readMarker: () => marker,
    writeMarker: (value) => {
      marker = value;
    },
    newId: () => "first",
  });
  storage.choose(EnvironmentId.make("env"));
  fail = true;
  expect(() => storage.choose(null)).toThrow("unavailable");
  expect(await storage.read()).toBeNull();
});

it("still clears the stored grant when the marker cannot be updated", async () => {
  let secret: string | null = null;
  let marker = "";
  let fail = false;
  const storage = createVoiceGrantStorage({
    readSecret: async () => secret,
    writeSecret: (value) => {
      secret = value;
    },
    readMarker: () => marker,
    writeMarker: (value) => {
      if (fail) throw new Error("unavailable");
      marker = value;
    },
    newId: () => "first",
  });
  storage.choose(EnvironmentId.make("env"));
  fail = true;
  expect(() => storage.choose(null)).toThrow("unavailable");
  expect(marker).toBe("first");
  expect(await storage.read()).toBeNull();
});

it("treats a grant without its device marker as revoked", async () => {
  const storage = createVoiceGrantStorage({
    readSecret: async () => JSON.stringify({ id: "kept", environmentId: "env" }),
    writeSecret: () => {},
    readMarker: () => null,
    writeMarker: () => {},
    newId: () => "unused",
  });
  expect(await storage.read()).toBeNull();
});
