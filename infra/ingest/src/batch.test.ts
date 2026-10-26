import { describe, expect, it } from "vite-plus/test";

import { MAX_EVENTS, parseBatch } from "./batch.ts";

const KEY = "goat_public_ingest_v1";
const KEYS = new Set([KEY]);
const INSTALL = "a".repeat(64);
const OTHER_INSTALL = "b".repeat(64);
const uuid = (n: number) => `0199a000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

const serverProperties = {
  installId: INSTALL,
  platform: "darwin",
  arch: "arm64",
  t3CodeVersion: "0.1.2",
  telemetryChannel: "nightly",
  clientType: "desktop-app",
  serverOs: "macOS",
  serverArch: "arm64",
  serverAppVersion: "0.1.2",
  serverMode: "desktop",
};

describe("parseBatch", () => {
  it("stores only allowlisted events and properties, never flat sensitive fields, nested values or extra fields", () => {
    const parsed = parseBatch(
      {
        api_key: KEY,
        batch: [
          {
            uuid: uuid(1).toUpperCase(),
            event: "provider.turn.completed",
            distinct_id: INSTALL,
            timestamp: "2026-10-25T01:02:03+09:00",
            ip: "203.0.113.7",
            user_agent: "curl/8",
            $set: { email: "someone@example.com" },
            properties: {
              provider: "codex",
              inputTokens: 1200,
              hasSubagents: false,
              model: { nested: { prompt: "do not keep" } },
              effort: "x".repeat(257),
              durationMs: Number.POSITIVE_INFINITY,
              threadCount: 3,
              prompt: "Refactor my secret project",
              authorization: "Bearer secret",
              deviceName: "Jun's MacBook",
              ipv6: "2001:db8::1",
              $ip: "203.0.113.7",
              $geoip_city_name: "Seoul",
              $process_person_profile: false,
            },
          },
          { uuid: uuid(2), event: "debug.dump", distinct_id: INSTALL, properties: { file: "x" } },
        ],
      },
      KEYS,
    );

    expect(parsed).toEqual({
      ok: true,
      eventCount: 1,
      batch: {
        distinct_id: INSTALL,
        events: [
          {
            uuid: uuid(1),
            event: "provider.turn.completed",
            timestamp: "2026-10-24T16:02:03.000Z",
            properties: { provider: "codex", hasSubagents: false, inputTokens: 1200 },
          },
        ],
      },
    });
  });

  it("keeps the install id and the properties every event shares once per batch", () => {
    const parsed = parseBatch(
      {
        api_key: KEY,
        batch: [
          {
            uuid: uuid(1),
            event: "feature.used",
            distinct_id: INSTALL,
            properties: { ...serverProperties, feature: "thread.fork", surface: "web" },
          },
          {
            uuid: uuid(2),
            event: "server.boot.heartbeat",
            distinct_id: INSTALL,
            properties: { ...serverProperties, threadCount: 4, projectCount: 2 },
          },
        ],
      },
      KEYS,
    );

    expect(parsed).toEqual({
      ok: true,
      eventCount: 2,
      batch: {
        distinct_id: INSTALL,
        common: serverProperties,
        events: [
          {
            uuid: uuid(1),
            event: "feature.used",
            properties: { feature: "thread.fork", surface: "web" },
          },
          {
            uuid: uuid(2),
            event: "server.boot.heartbeat",
            properties: { threadCount: 4, projectCount: 2 },
          },
        ],
      },
    });
  });

  it("keeps each event's install id when a batch mixes installs", () => {
    const parsed = parseBatch(
      {
        api_key: KEY,
        batch: [
          { uuid: uuid(1), event: "server.boot.heartbeat", distinct_id: INSTALL },
          { uuid: uuid(2), event: "server.boot.heartbeat", distinct_id: OTHER_INSTALL },
        ],
      },
      KEYS,
    );

    expect(parsed.ok && parsed.batch).toEqual({
      events: [
        { uuid: uuid(1), event: "server.boot.heartbeat", distinct_id: INSTALL },
        { uuid: uuid(2), event: "server.boot.heartbeat", distinct_id: OTHER_INSTALL },
      ],
    });
  });

  it("refuses with the status the server treats as final when a batch can never be accepted", () => {
    const event = { uuid: uuid(1), event: "server.boot.heartbeat", distinct_id: INSTALL };
    const cases: ReadonlyArray<readonly [unknown, number]> = [
      [{ api_key: "phc_XOWci4oZP4VvLiEyrFqkFjP4CZn55mjYYBMREK5Wd6m", batch: [event] }, 401],
      [{ batch: [event] }, 401],
      [[event], 400],
      [{ api_key: KEY, batch: [] }, 400],
      [{ api_key: KEY, batch: Array.from({ length: MAX_EVENTS + 1 }, () => event) }, 413],
      [{ api_key: KEY, batch: [{ ...event, uuid: "not-a-uuid" }] }, 400],
      [{ api_key: KEY, batch: [{ ...event, distinct_id: "raw-account-id@example.com" }] }, 400],
      [{ api_key: KEY, batch: [{ ...event, event: "debug.dump" }] }, 400],
    ];
    for (const [body, status] of cases) {
      expect(parseBatch(body, KEYS)).toEqual({ ok: false, status });
    }
  });
});
