import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { BrowserClaimWindowsUnavailable, listBrowserClaimWindows } from "./BrowserClaimWindows.ts";

it.effect("lists only browser windows and reports protected and unapproved processes", () =>
  Effect.gen(function* () {
    const calls: number[] = [];
    const result = yield* listBrowserClaimWindows((tool, args) => {
      if (tool === "list_apps")
        return Effect.succeed({
          structuredContent: {
            apps: [
              { pid: 1, name: "Google Chrome", bundle_id: "com.google.Chrome", running: true },
              { pid: 2, name: "Microsoft Edge", bundle_id: "com.microsoft.edgemac", running: true },
              { pid: 3, name: "Chromium", bundle_id: "org.chromium.Chromium", running: true },
              { pid: 4, name: "Mail", bundle_id: "com.apple.mail", running: true },
            ],
          },
        });
      const pid = Number(args.pid);
      calls.push(pid);
      if (pid === 2)
        return Effect.succeed({
          isError: true,
          structuredContent: { refusal: { code: "browser_process_protected" } },
        });
      if (pid === 3)
        return Effect.succeed({
          isError: true,
          structuredContent: { refusal: { code: "outside_manifest" } },
        });
      return Effect.succeed({
        structuredContent: {
          windows: [
            { pid: 1, window_id: 10, title: "Browser window" },
            { pid: 4, window_id: 11, title: "Private mail" },
          ],
        },
      });
    });
    assert.deepEqual(calls, [1, 2, 3]);
    assert.deepEqual(result.windows, [
      { pid: 1, windowId: 10, title: "Browser window", app: "Google Chrome" },
    ]);
    assert.deepEqual(
      result.refused.map((entry) => entry.reason),
      ["browser_process_protected", "outside_manifest"],
    );
  }),
);

it.effect("reports unavailable when the driver fails", () =>
  Effect.gen(function* () {
    const result = yield* listBrowserClaimWindows(() =>
      Effect.fail(new BrowserClaimWindowsUnavailable({ cause: "driver down" })),
    ).pipe(Effect.result);
    assert.equal(result._tag, "Failure");
  }),
);
