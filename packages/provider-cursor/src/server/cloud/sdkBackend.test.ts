import { expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import { loadCursorSdk } from "../sdk.ts";
import { makeHarness } from "./adapter.testkit.ts";

it.live("refuses cloud operations when the SDK retained a foreign authentication backend", () =>
  Effect.gen(function* () {
    const previous = process.env.CURSOR_BACKEND_URL;
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        requests.push(String(input));
        return new Response("{}", { status: 200 });
      }),
    );
    try {
      process.env.CURSOR_BACKEND_URL = "https://first.invalid";
      const sdk = loadCursorSdk();
      delete process.env.CURSOR_BACKEND_URL;
      yield* Effect.promise(() =>
        sdk.Cursor.models.list({ apiKey: "fixture-key" }).catch(() => undefined),
      );
      expect(requests).toContain("https://first.invalid/auth/exchange_user_api_key");
      expect(
        requests.every(
          (url) =>
            url.startsWith("https://first.invalid/") || url.startsWith("https://api.cursor.com/"),
        ),
      ).toBe(true);
      requests.length = 0;
      yield* Effect.gen(function* () {
        const h = yield* makeHarness();
        const result = yield* h.runtime.startTurn(h.input).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(h.create).not.toHaveBeenCalled();
      }).pipe(Effect.provide(IdAllocator.layer), Effect.scoped);
      expect(requests).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.CURSOR_BACKEND_URL;
      else process.env.CURSOR_BACKEND_URL = previous;
      vi.unstubAllGlobals();
    }
  }),
);
