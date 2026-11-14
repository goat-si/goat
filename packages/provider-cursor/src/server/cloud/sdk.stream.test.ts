import { expect, it, vi } from "vite-plus/test";
import { loadCursorSdk } from "../sdk.ts";
import { guardedStream } from "./sdk.ts";

it("keeps the production destination across stream messages and reconnects", async () => {
  const originalEnv = process.env;
  const env = { ...originalEnv };
  delete env.CURSOR_BACKEND_URL;
  let reads = 0;
  const requests: Array<{ url: string; headers: Headers }> = [];
  const opened = Promise.withResolvers<void>();
  const refetched = Promise.withResolvers<void>();
  const reconnected = Promise.withResolvers<void>();
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  const runData = {
    id: "run-11111111-1111-4111-8111-111111111111",
    agentId: "bc-11111111-1111-4111-8111-111111111111",
    status: "RUNNING",
    createdAt: "2026-01-01T00:00:00Z",
  };
  let streamCount = 0;
  vi.useFakeTimers();
  Object.defineProperty(process, "env", {
    configurable: true,
    value: new Proxy(env, {
      get(target, key) {
        if (key === "CURSOR_BACKEND_URL") reads++;
        return Reflect.get(target, key);
      },
    }),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      requests.push({ url, headers });
      if (url.endsWith("/auth/exchange_user_api_key"))
        return Response.json({ accessToken: "fixture-token" });
      if (url.endsWith("/stream")) {
        streamCount++;
        if (streamCount === 2) {
          reconnected.resolve();
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode('event: result\ndata: {"status":"FINISHED"}\n\n'),
                );
                controller.close();
              },
            }),
          );
        }
        return new Response(
          new ReadableStream({
            start(controller) {
              streamController = controller;
              opened.resolve();
            },
          }),
        );
      }
      if (url.endsWith("/runs/run-11111111-1111-4111-8111-111111111111")) {
        if (streamCount === 1) refetched.resolve();
        return Response.json(runData);
      }
      return Response.json({});
    }),
  );
  try {
    const sdk = loadCursorSdk();
    const run = await sdk.Agent.getRun("run-11111111-1111-4111-8111-111111111111", {
      runtime: "cloud",
      agentId: "bc-11111111-1111-4111-8111-111111111111",
      apiKey: "fixture-key",
    });
    const iterator = guardedStream(run, () => new Error("backend mismatch"));
    const first = iterator.next();
    await opened.promise;
    streamController.enqueue(
      new TextEncoder().encode(
        'id: 42\nevent: heartbeat\ndata: {}\n\nevent: assistant\ndata: {"text":"one"}\n\nevent: assistant\ndata: {"text":"two"}\n\n',
      ),
    );
    expect((await first).done).toBe(false);
    const before = reads;
    expect((await iterator.next()).done).toBe(false);
    expect(reads).toBe(before);
    env.CURSOR_BACKEND_URL = "https://foreign.invalid";
    expect(() => guardedStream(run, () => new Error("backend mismatch"))).toThrow(
      "backend mismatch",
    );
    streamController.close();
    await refetched.promise;
    await vi.advanceTimersByTimeAsync(1000);
    await reconnected.promise;
    expect(
      requests
        .filter(({ url }) => url.endsWith("/stream"))
        .map(({ url, headers }) => [url, headers.get("Last-Event-ID")]),
    ).toEqual([
      [
        "https://api.cursor.com/v1/agents/bc-11111111-1111-4111-8111-111111111111/runs/run-11111111-1111-4111-8111-111111111111/stream",
        null,
      ],
      [
        "https://api.cursor.com/v1/agents/bc-11111111-1111-4111-8111-111111111111/runs/run-11111111-1111-4111-8111-111111111111/stream",
        "42",
      ],
    ]);
    expect(
      requests
        .filter(({ url }) => url.endsWith("/stream"))
        .map(({ headers }) => headers.get("authorization")),
    ).toEqual(["Bearer fixture-key", "Bearer fixture-key"]);
    expect(
      requests.every(
        ({ url }) =>
          url.startsWith("https://api.cursor.com/") || url.startsWith("https://api2.cursor.sh/"),
      ),
    ).toBe(true);
    await iterator.return();
  } finally {
    Object.defineProperty(process, "env", { configurable: true, value: originalEnv });
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});
