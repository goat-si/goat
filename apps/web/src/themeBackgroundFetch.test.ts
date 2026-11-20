import { expect, it, vi } from "vite-plus/test";
import { fetchThemeBackground, retryBackgroundMint } from "./themeBackgroundFetch";

it("retries an unavailable mint but not a permission denial", async () => {
  const mint = vi
    .fn()
    .mockRejectedValueOnce({ _tag: "EnvironmentRpcUnavailableError" })
    .mockResolvedValue("token");
  expect(await retryBackgroundMint(mint, new AbortController().signal, async () => {})).toBe(
    "token",
  );
  expect(mint).toHaveBeenCalledTimes(2);
  const denied = vi.fn().mockRejectedValue({ _tag: "EnvironmentAuthorizationError" });
  await expect(
    retryBackgroundMint(denied, new AbortController().signal, async () => {}),
  ).rejects.toMatchObject({ _tag: "EnvironmentAuthorizationError" });
  expect(denied).toHaveBeenCalledTimes(1);
});

it("recovers from a transient network failure and server error", async () => {
  const request = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("offline"))
    .mockResolvedValueOnce(new Response(null, { status: 502 }))
    .mockResolvedValue(new Response("ok", { status: 200 }));
  const response = await fetchThemeBackground(
    "https://goat.example/image",
    new AbortController().signal,
    request,
    async () => {},
  );
  expect(response.status).toBe(200);
  expect(request).toHaveBeenCalledTimes(3);
});

it("retries temporary 503 responses a bounded number of times", async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValue(new Response("ok", { status: 200 }));
  const wait = vi.fn(async () => {});
  const response = await fetchThemeBackground(
    "https://goat.example/image",
    new AbortController().signal,
    request,
    wait,
  );
  expect(response.status).toBe(200);
  expect(request).toHaveBeenCalledTimes(3);
  expect(wait).toHaveBeenCalledTimes(2);
});

it("stops after three busy responses", async () => {
  const request = vi.fn(async () => new Response(null, { status: 503 }));
  const response = await fetchThemeBackground(
    "https://goat.example/image",
    new AbortController().signal,
    request,
    async () => {},
  );
  expect(response.status).toBe(503);
  expect(request).toHaveBeenCalledTimes(3);
});

it("stops retrying when the selection is cancelled during backoff", async () => {
  const request = vi.fn(async () => new Response(null, { status: 503 }));
  const controller = new AbortController();
  let markWaiting = () => {};
  const waiting = new Promise<void>((resolve) => {
    markWaiting = resolve;
  });
  const wait = (_ms: number, signal: AbortSignal) =>
    new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
        once: true,
      });
      markWaiting();
    });
  const result = fetchThemeBackground(
    "https://goat.example/image",
    controller.signal,
    request,
    wait,
  );
  await waiting;
  controller.abort();
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
  expect(request).toHaveBeenCalledTimes(1);
});
