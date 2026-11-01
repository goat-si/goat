import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { ScreenTargetRef } from "@goat/contracts";
import { call, context, DriverError, fixture } from "./DesktopTargetHost.testkit.ts";

it.effect.each([
  { code: "desktop_busy", message: "desktop input is busy" },
  { code: "desktop_lease_unavailable", message: "lease check failed" },
])("$code refuses point input without invalidating the target", ({ code, message }) =>
  Effect.gen(function* () {
    let clicks = 0;
    const { host, sent } = fixture({
      click: () =>
        ++clicks === 1
          ? new DriverError({
              effect: "refused",
              code,
              status: "refused",
              refusal: { code, message },
            })
          : { effect: "confirmed" },
    });
    const bound = yield* host.bindApp(
      call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
      context,
    );
    const target = bound.value as ScreenTargetRef;
    const first = yield* host
      .invoke(call("click", { x: 1, y: 2 }, target), context)
      .pipe(Effect.result);
    expect(first._tag).toBe("Failure");
    if (first._tag === "Failure")
      expect(first.failure).toMatchObject({
        code: "unavailable",
        effectStarted: false,
        safety: { possibleCommit: false },
        nextStep:
          code === "desktop_busy"
            ? "Another driver session is using the desktop input; nothing was sent. Wait a moment, observe again, then act."
            : "lease check failed; nothing was sent. Wait a moment, observe again, then act.",
      });
    expect(sent.filter((entry) => entry.tool === "click")).toHaveLength(1);
    const second = yield* host
      .invoke(call("click", { x: 1, y: 2 }, target), context)
      .pipe(Effect.result);
    expect(second._tag).toBe("Success");
  }),
);

it.effect("an unrelated driver refusal remains a permission refusal", () =>
  Effect.gen(function* () {
    const { host } = fixture({
      click: new DriverError({
        effect: "refused",
        refusal: { code: "outside_scope", message: "not allowed" },
      }),
    });
    const bound = yield* host.bindApp(
      call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
      context,
    );
    const result = yield* host
      .invoke(call("click", { x: 1, y: 2 }, bound.value as ScreenTargetRef), context)
      .pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure")
      expect(result.failure).toMatchObject({ code: "permission_denied", nextStep: "not allowed" });
  }),
);
it.effect("a busy menu command is refused unsent", () =>
  Effect.gen(function* () {
    const { host, sent } = fixture({
      invoke_menu: new DriverError({
        effect: "refused",
        code: "desktop_busy",
        status: "refused",
        refusal: { code: "desktop_busy", message: "desktop input is busy" },
      }),
    });
    const bound = yield* host.bindApp(
      call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
      context,
    );
    const result = yield* host
      .invoke(
        call("invoke_menu", { path: ["Format", "Font", "Bold"] }, bound.value as ScreenTargetRef),
        context,
      )
      .pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure")
      expect(result.failure).toMatchObject({
        code: "unavailable",
        effectStarted: false,
        safety: { possibleCommit: false },
      });
    expect(sent.filter((entry) => entry.tool === "invoke_menu")).toHaveLength(1);
  }),
);
