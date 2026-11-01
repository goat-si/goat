// @effect-diagnostics globalDate:off - Tests drive the Worker's plain Date API with fixed instants.
import { describe, expect, it } from "vite-plus/test";

import { MAX_BODY_BYTES } from "./batch.ts";
import { sqliteD1 } from "./sqliteD1.testkit.ts";
import { handleRequest, runRetention } from "./worker.ts";

const NOW = new Date("2026-10-25T03:00:00Z");
const INSTALL = "c".repeat(64);
const CLIENT_IP = "198.51.100.23";
const USER_AGENT = "goat-test-agent/1.0";

function environment(
  overrides: { limit?: () => Promise<{ success: boolean }>; budget?: string } = {},
) {
  const store = sqliteD1();
  const limiterKeys: Array<string> = [];
  const env = {
    DB: store.db,
    RATE_LIMITER: {
      limit: ({ key }: { key: string }) => {
        limiterKeys.push(key);
        return overrides.limit?.() ?? Promise.resolve({ success: true });
      },
    },
    ACCEPTED_KEYS: "goat_public_ingest_v1",
    RETENTION_DAYS: "180",
    DAILY_BATCH_BUDGET: overrides.budget ?? "20000",
    DAILY_BYTE_BUDGET: "2400000",
  };
  return { env, store, limiterKeys };
}

const body = (properties: Record<string, unknown> = { threadCount: 2, projectCount: 1 }) =>
  JSON.stringify({
    api_key: "goat_public_ingest_v1",
    batch: [
      {
        uuid: "0199a000-0000-7000-8000-000000000001",
        event: "server.boot.heartbeat",
        distinct_id: INSTALL,
        properties,
      },
    ],
  });

const post = (payload: BodyInit, headers: Record<string, string> = {}) =>
  new Request("https://ingest.trygoat.ai/batch/", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": CLIENT_IP,
      "user-agent": USER_AGENT,
      "x-forwarded-for": "192.0.2.99",
      ...headers,
    },
    body: payload,
  });

describe("handleRequest", () => {
  it("stores an accepted batch without the client's address or user agent", async () => {
    const { env, store, limiterKeys } = environment();
    const response = await handleRequest(post(body()), env, NOW);

    expect(response.status).toBe(200);
    expect(limiterKeys).toEqual([CLIENT_IP]);
    const rows = store.rows();
    expect(rows).toEqual([
      {
        day: "2026-10-25",
        eventCount: 1,
        events: JSON.stringify({
          distinct_id: INSTALL,
          events: [
            {
              uuid: "0199a000-0000-7000-8000-000000000001",
              event: "server.boot.heartbeat",
              properties: { threadCount: 2, projectCount: 1 },
            },
          ],
        }),
      },
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/198\.51\.100\.23|192\.0\.2\.99|goat-test-agent/);
  });

  it("drops a deeply nested property below the size cap without failing the batch", async () => {
    const { env, store } = environment();
    const depth = 20_000;
    const nested = '{"a":'.repeat(depth) + "1" + "}".repeat(depth);
    const payload = body({ threadCount: 2 }).replace(
      '"threadCount":2',
      `"threadCount":2,"projectCount":${nested}`,
    );
    expect(payload.length).toBeLessThan(MAX_BODY_BYTES);

    const response = await handleRequest(post(payload), env, NOW);
    expect(response.status).toBe(200);
    expect(store.rows()[0]?.events).toContain('"properties":{"threadCount":2}');
  });

  it("answers each refusal with the status the server's retry logic expects, storing nothing", async () => {
    const cases: ReadonlyArray<readonly [string, () => Promise<Response>, number]> = [
      [
        "wrong path",
        () =>
          handleRequest(
            new Request("https://ingest.trygoat.ai/capture/", { method: "POST" }),
            environment().env,
            NOW,
          ),
        404,
      ],
      [
        "wrong method",
        () =>
          handleRequest(new Request("https://ingest.trygoat.ai/batch/"), environment().env, NOW),
        405,
      ],
      [
        "declared length over the cap",
        () =>
          handleRequest(
            post(body(), { "content-length": String(MAX_BODY_BYTES + 1) }),
            environment().env,
            NOW,
          ),
        413,
      ],
      [
        "streamed body over the cap",
        () =>
          handleRequest(
            new Request("https://ingest.trygoat.ai/batch/", {
              method: "POST",
              body: new ReadableStream({
                pull(controller) {
                  controller.enqueue(new Uint8Array(32 * 1024));
                },
              }),
              duplex: "half",
            } as RequestInit),
            environment().env,
            NOW,
          ),
        413,
      ],
      ["malformed JSON", () => handleRequest(post("{"), environment().env, NOW), 400],
      [
        "invalid UTF-8",
        () => handleRequest(post(new Uint8Array([0x7b, 0xff, 0x7d])), environment().env, NOW),
        400,
      ],
      [
        "upstream key",
        () =>
          handleRequest(
            post(body().replace("goat_public_ingest_v1", "phc_upstream")),
            environment().env,
            NOW,
          ),
        401,
      ],
      [
        "rate limited",
        () =>
          handleRequest(
            post(body()),
            environment({ limit: () => Promise.resolve({ success: false }) }).env,
            NOW,
          ),
        429,
      ],
      [
        "rate limiter failed",
        () =>
          handleRequest(
            post(body()),
            environment({ limit: () => Promise.reject(new Error("down")) }).env,
            NOW,
          ),
        503,
      ],
      [
        "misconfigured budget",
        () => handleRequest(post(body()), environment({ budget: "0" }).env, NOW),
        503,
      ],
    ];
    for (const [name, send, status] of cases) {
      expect({ name, status: (await send()).status }).toEqual({ name, status });
    }
  });

  it("answers 503 when the budget is spent or D1 fails, so the server retries later", async () => {
    const spent = environment({ budget: "1" });
    expect((await handleRequest(post(body()), spent.env, NOW)).status).toBe(200);
    expect((await handleRequest(post(body({ threadCount: 3 })), spent.env, NOW)).status).toBe(503);

    const failing = environment();
    const env = {
      ...failing.env,
      DB: { ...failing.env.DB, batch: () => Promise.reject(new Error("D1_ERROR")) },
    };
    expect((await handleRequest(post(body()), env, NOW)).status).toBe(503);
  });
});

describe("runRetention", () => {
  it("deletes expired days on the scheduled run", async () => {
    const { env, store } = environment();
    await handleRequest(post(body()), env, new Date("2026-04-29T12:00:00Z"));
    await handleRequest(post(body()), env, new Date("2026-04-30T12:00:00Z"));
    await runRetention(env, new Date("2026-10-25T00:17:00Z"));
    expect(store.rows().map((row) => row.day)).toEqual(["2026-04-30"]);
  });
});
