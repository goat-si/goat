import { describe, expect, it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { loadUrlAllowingRedirects } from "./loadUrlAllowingRedirects.ts";

class LoadFailed extends Data.TaggedError("LoadFailed")<{ readonly cause: unknown }> {}

// Same shape Electron's loadURL rejects with in lib/browser/api/web-contents.ts.
const loadError = (errno: number, code: string, url: string) =>
  Object.assign(new Error(code + " (" + errno + ") loading '" + url + "'"), { errno, code, url });

const fakeWebContents = (load: (preventUnload: () => void) => Promise<void>) => {
  const listeners = new Set<() => void>();
  return {
    listeners,
    on: (_event: "will-prevent-unload", listener: () => void) => listeners.add(listener),
    off: (_event: "will-prevent-unload", listener: () => void) => listeners.delete(listener),
    loadURL: () => load(() => listeners.forEach((listener) => listener())),
  };
};

const navigate = (webContents: ReturnType<typeof fakeWebContents>) =>
  loadUrlAllowingRedirects(webContents, "https://example.com/", (load) =>
    Effect.tryPromise({ try: load, catch: (cause) => new LoadFailed({ cause }) }),
  );

describe("loadUrlAllowingRedirects", () => {
  it.effect("treats a load superseded by a page redirect as a successful navigation", () =>
    Effect.gen(function* () {
      const redirected = fakeWebContents(() =>
        Promise.reject(loadError(-3, "ERR_ABORTED", "https://example.com/target")),
      );
      expect(Exit.isSuccess(yield* Effect.exit(navigate(redirected)))).toBe(true);
      expect(redirected.listeners.size).toBe(0);
    }),
  );

  it.effect("fails when the page blocks its unload or the load itself fails", () =>
    Effect.gen(function* () {
      const blocked = fakeWebContents((preventUnload) => {
        preventUnload();
        return Promise.reject(loadError(-3, "ERR_ABORTED", "https://example.com/blocked"));
      });
      expect(Exit.isFailure(yield* Effect.exit(navigate(blocked)))).toBe(true);
      expect(blocked.listeners.size).toBe(0);

      const missing = fakeWebContents(() =>
        Promise.reject(loadError(-105, "ERR_NAME_NOT_RESOLVED", "https://missing.invalid/")),
      );
      const failed = yield* Effect.exit(navigate(missing));
      expect(Exit.isFailure(failed)).toBe(true);
    }),
  );
});
