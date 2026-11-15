import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { cursorVerificationUrl, sameCursorBackend, sdkBackendMatches } from "./sdkBackend.ts";

/** Runs with the server's CURSOR_BACKEND_URL unset, then restores it. */
const withDefaultServerBackend = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.CURSOR_BACKEND_URL;
      delete process.env.CURSOR_BACKEND_URL;
      return previous;
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        if (previous !== undefined) process.env.CURSOR_BACKEND_URL = previous;
      }),
  );

it.effect("a session naming Cursor's backend another way passes the loaded backend check", () =>
  withDefaultServerBackend(
    Effect.sync(() => {
      expect(sdkBackendMatches("HTTPS://API2.Cursor.sh:443/")).toBe(true);
      expect(sdkBackendMatches("https://private.invalid")).toBe(false);
    }),
  ),
);

it.effect("sign-in treats equivalent spellings of one backend as the same backend", () =>
  Effect.sync(() => {
    expect(sameCursorBackend("https://api2.cursor.sh", "HTTPS://API2.Cursor.sh:443/")).toBe(true);
    expect(sameCursorBackend(undefined, "https://api2.cursor.sh:443")).toBe(true);
    expect(sameCursorBackend("https://api2.cursor.sh", "https://private.invalid")).toBe(false);
    // Production sign-ins are verified at Cursor's public API, however the backend is written.
    expect(cursorVerificationUrl("HTTPS://API2.Cursor.sh:443")).toBe("https://api.cursor.com");
    expect(cursorVerificationUrl("https://private.invalid/")).toBe("https://private.invalid");
  }),
);
